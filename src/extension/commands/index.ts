import * as path from 'node:path';
import * as vscode from 'vscode';
import { fieldDefaults, validateValues, type ClusterConnection, type DiskDevice, type FieldSchema, type PowerAction } from '@vmm/sdk';
import type { VmRef } from '../../shared/protocol';
import type { ClusterStore } from '../clusters/ClusterStore';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import type { ProviderRegistry } from '../registry/ProviderRegistry';
import type { VmTreeProvider } from '../tree/VmTreeProvider';
import { stateLabel } from '../tree/VmTreeProvider';
import { BACK, collectFields, pickStep, textStep, type PickItem } from '../input/MultiStepInput';
import type { ConsoleManager } from '../webview/ConsoleManager';
import type { RdpCredentialStore } from '../rdp/credentials';
import { OverviewPanel } from '../webview/OverviewPanel';
import { VmSettingsPanel } from '../webview/VmSettingsPanel';
import { errorMessage, log, showError } from '../util/log';
import { OPERATION_LABEL, OPERATION_TITLE, allowedDuring } from '../../shared/operations';

export const WALKTHROUGH_ID = 'sourceregistry.vm-manager#gettingStarted';

export interface CommandDeps {
	context: vscode.ExtensionContext;
	store: ClusterStore;
	registry: ProviderRegistry;
	manager: ConnectionManager;
	tree: VmTreeProvider;
	consoles: ConsoleManager;
	credentials: RdpCredentialStore;
}

type Arg = unknown;

// ---------------------------------------------------------------------------------------------
// Argument resolution: commands accept tree elements, VmRefs (overview), or nothing (palette).
// ---------------------------------------------------------------------------------------------

function asRecord(arg: Arg): Record<string, unknown> | undefined {
	return arg && typeof arg === 'object' ? (arg as Record<string, unknown>) : undefined;
}

function asVmRef(arg: Arg): VmRef | undefined {
	const a = asRecord(arg);
	if (a && typeof a.clusterId === 'string' && typeof a.nodeId === 'string' && typeof a.vmId === 'string') {
		return { clusterId: a.clusterId, nodeId: a.nodeId, vmId: a.vmId };
	}
	return undefined;
}

function asNodeRef(arg: Arg): { clusterId: string; nodeId: string } | undefined {
	const a = asRecord(arg);
	if (a && typeof a.clusterId === 'string' && typeof a.nodeId === 'string') return { clusterId: a.clusterId, nodeId: a.nodeId };
	return undefined;
}

function asClusterId(arg: Arg): string | undefined {
	const a = asRecord(arg);
	return a && typeof a.clusterId === 'string' ? a.clusterId : undefined;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
	const { context, store, registry, manager, tree, consoles, credentials } = deps;

	async function loadAll(): Promise<void> {
		await Promise.all(manager.clusters().map((c) => manager.ensureLoaded(c.cluster.id)));
	}

	async function resolveVm(arg: Arg, placeholder: string, filter: (l: VmLocation) => boolean = () => true): Promise<VmLocation | undefined> {
		const ref = asVmRef(arg);
		if (ref) {
			const location = manager.findVm(ref);
			if (!location) void vscode.window.showWarningMessage('Virtual machine not found. Try refreshing.');
			return location;
		}
		await loadAll();
		const candidates = manager.allVms().filter(filter);
		if (!candidates.length) {
			void vscode.window.showInformationMessage('No matching virtual machines.');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(
			candidates.map((l) => ({
				label: l.vm.name,
				description: stateLabel(l.vm.state),
				detail: `${l.cluster.cluster.name} › ${l.node.name}`,
				location: l
			})),
			{ placeHolder: placeholder, matchOnDetail: true }
		);
		return picked?.location;
	}

	async function resolveCluster(arg: Arg, placeholder: string): Promise<string | undefined> {
		const id = asClusterId(arg);
		if (id) return id;
		const clusters = manager.clusters();
		if (clusters.length === 1) return clusters[0].cluster.id;
		const picked = await vscode.window.showQuickPick(
			clusters.map((c) => ({ label: c.cluster.name, description: registry.displayName(c.cluster.providerId), id: c.cluster.id })),
			{ placeHolder: placeholder }
		);
		return picked?.id;
	}

	async function resolveNode(arg: Arg): Promise<{ clusterId: string; nodeId: string } | undefined> {
		const ref = asNodeRef(arg);
		if (ref) return ref;
		await loadAll();
		const clusterFilter = asClusterId(arg);
		const nodes = manager
			.clusters()
			.filter((c) => c.connection?.capabilities.create && (!clusterFilter || c.cluster.id === clusterFilter))
			.flatMap((c) => c.nodes.filter((n) => n.status === 'online').map((n) => ({ cluster: c, node: n })));
		if (!nodes.length) {
			void vscode.window.showInformationMessage('No connected node supports creating virtual machines.');
			return undefined;
		}
		if (nodes.length === 1) return { clusterId: nodes[0].cluster.cluster.id, nodeId: nodes[0].node.id };
		const picked = await vscode.window.showQuickPick(
			nodes.map((n) => ({
				label: n.node.name,
				description: n.cluster.cluster.name,
				ref: { clusterId: n.cluster.cluster.id, nodeId: n.node.id }
			})),
			{ placeHolder: 'Select the node to create the virtual machine on' }
		);
		return picked?.ref;
	}

	function inView<T>(task: () => Promise<T>): Thenable<T> {
		return vscode.window.withProgress({ location: { viewId: 'vmm.clusters' } }, task);
	}

	// -----------------------------------------------------------------------------------------
	// Power
	// -----------------------------------------------------------------------------------------

	async function power(arg: Arg, action: PowerAction, confirmed = false): Promise<void> {
		const idle = (l: VmLocation) => !l.vm.operation;
		const filters: Record<PowerAction, (l: VmLocation) => boolean> = {
			start: (l) => idle(l) && l.vm.state !== 'running',
			shutdown: (l) => idle(l) && l.vm.state === 'running',
			reboot: (l) => idle(l) && l.vm.state === 'running',
			stop: (l) => (l.vm.operation ? allowedDuring(l.vm.operation, 'stop') : l.vm.state !== 'stopped'),
			reset: (l) => idle(l) && l.vm.state === 'running'
		};
		const verbs: Record<PowerAction, string> = {
			start: 'start',
			shutdown: 'shut down',
			reboot: 'reboot',
			stop: 'power off',
			reset: 'reset'
		};
		const location = await resolveVm(arg, `Select a virtual machine to ${verbs[action]}`, filters[action]);
		if (!location) return;
		if (action === 'stop' && !confirmed && vscode.workspace.getConfiguration('vmm').get<boolean>('confirmPowerOff', true)) {
			const choice = await vscode.window.showWarningMessage(
				`Power off "${location.vm.name}"?`,
				{ modal: true, detail: 'This is like pulling the power plug. Unsaved data in the guest may be lost. Use Shut Down for a clean shutdown.' },
				'Power Off'
			);
			if (choice !== 'Power Off') return;
		}
		const running = manager.operation(location.ref);
		if (running && !allowedDuring(running, action)) {
			void vscode.window.showInformationMessage(`${location.vm.name}: ${OPERATION_LABEL[running]}`);
			return;
		}
		// Background task: the command returns at once, the VM shows a spinner until the
		// hypervisor call returns (a graceful shutdown can take minutes).
		const name = location.vm.name;
		const task = manager.power(location.ref, action);
		void vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `${OPERATION_TITLE[action]} ${name}` },
			() => task.catch(() => undefined)
		);
		task.catch((error: unknown) => {
			// The guest ignored a graceful request: don't leave the user stuck, offer the hard way out.
			// Duck-typed: the provider extension bundles its own copy of the SDK's ProviderError.
			if ((action === 'shutdown' || action === 'reboot') && (error as { code?: unknown } | undefined)?.code === 'timeout') {
				log.warn(`${name}: ${errorMessage(error)}`);
				// Modal: a toast fades into the notification centre and the VM silently goes back to "Running".
				void vscode.window
					.showWarningMessage(
						`"${name}" did not ${action === 'reboot' ? 'reboot' : 'shut down'}`,
						{ modal: true, detail: `${errorMessage(error)}\n\nPower Off is like pulling the power plug: unsaved data in the guest may be lost.` },
						'Power Off'
					)
					.then((choice) => {
						if (choice === 'Power Off') void power(location.ref, 'stop', true);
					});
				return;
			}
			return showError(`Could not ${verbs[action]} ${name}`, error);
		});
	}

	// -----------------------------------------------------------------------------------------
	// Installation media
	// -----------------------------------------------------------------------------------------

	/** The CD/DVD drive to act on: the only one, or the user's pick. */
	async function pickDrive(location: VmLocation, connection: ClusterConnection, wantMedia: boolean): Promise<DiskDevice | undefined> {
		const details = await connection.getVmDetails?.(location.ref.nodeId, location.ref.vmId);
		const drives = (details?.disks ?? []).filter((d) => d.kind === 'cdrom' && d.removable !== false && (!wantMedia || d.path));
		if (!drives.length) {
			void vscode.window.showInformationMessage(
				wantMedia ? `${location.vm.name} has no media in its CD/DVD drives.` : `${location.vm.name} has no CD/DVD drive.`
			);
			return undefined;
		}
		if (drives.length === 1) return drives[0];
		const picked = await vscode.window.showQuickPick(
			drives.map((d) => ({ label: d.label, description: d.path ? path.basename(d.path) : 'Empty', detail: d.path, drive: d })),
			{ placeHolder: 'Select the CD/DVD drive' }
		);
		return picked?.drive;
	}

	async function ejectMedia(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to eject media from', (l) => !!l.cluster.connection?.capabilities.media && !!l.vm.mediaInserted);
		if (!location) return;
		try {
			const connection = await manager.connect(location.ref.clusterId);
			if (!connection.ejectMedia) return;
			const drive = await pickDrive(location, connection, true);
			if (!drive) return;
			await connection.ejectMedia(location.ref.nodeId, location.ref.vmId, drive.id);
			await manager.refresh(location.ref.clusterId);
			void vscode.window.setStatusBarMessage(`$(circle-slash) Ejected ${drive.path ? path.basename(drive.path) : 'media'} from ${location.vm.name}`, 4000);
		} catch (error) {
			await showError(`Could not eject media from ${location.vm.name}`, error);
		}
	}

	async function changeMedia(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to change the ISO of', (l) => !!l.cluster.connection?.capabilities.media);
		if (!location) return;
		try {
			const connection = await manager.connect(location.ref.clusterId);
			if (!connection.insertMedia) return;
			const drive = await pickDrive(location, connection, false);
			if (!drive) return;
			const picked = await vscode.window.showOpenDialog({
				title: `Insert into ${location.vm.name}`,
				canSelectMany: false,
				filters: { 'Disk images': ['iso', 'img'], 'All files': ['*'] }
			});
			if (!picked?.[0]) return;
			await connection.insertMedia(location.ref.nodeId, location.ref.vmId, drive.id, picked[0].fsPath);
			await manager.refresh(location.ref.clusterId);
			void vscode.window.setStatusBarMessage(`$(files) Inserted ${path.basename(picked[0].fsPath)} into ${location.vm.name}`, 4000);
		} catch (error) {
			await showError(`Could not change the media of ${location.vm.name}`, error);
		}
	}

	// -----------------------------------------------------------------------------------------
	// Clusters
	// -----------------------------------------------------------------------------------------

	async function addCluster(): Promise<void> {
		const title = 'Add Cluster';
		for (;;) {
			const available = registry.available();
			const items: PickItem<string>[] = available.map((p) => ({
				label: p.displayName,
				description: p.description,
				value: p.id
			}));
			items.push({ label: '$(extensions) Install more providers…', value: '__install__', alwaysShow: true });
			const picked = await pickStep({ title, step: 1, totalSteps: 2, canGoBack: false }, items, {
				placeholder: 'Select the hypervisor'
			});
			if (!picked || picked === BACK) return;
			if (picked.value === '__install__') {
				await vscode.commands.executeCommand('vmm.installProviders');
				return;
			}
			const provider = await registry.ensure(picked.value);
			if (!provider) {
				void vscode.window.showErrorMessage(`The ${picked.label} provider could not be activated.`);
				return;
			}
			const totalSteps = 2 + provider.connectionSchema.length;
			const defaultName = provider.defaultClusterName?.() ?? provider.displayName;
			const existingNames = new Set(store.all().map((c) => c.name));
			const name = await textStep(
				{ title, step: 2, totalSteps, canGoBack: true },
				{
					value: existingNames.has(defaultName) ? '' : defaultName,
					prompt: 'Cluster name',
					placeholder: defaultName,
					validate: (v) => (!v.trim() ? 'Name is required' : existingNames.has(v.trim()) ? 'A cluster with this name already exists' : undefined)
				}
			);
			if (name === undefined) return;
			if (name === BACK) continue;
			const values = await collectFields(provider.connectionSchema, fieldDefaults(provider.connectionSchema), {
				title,
				stepOffset: 2,
				canGoBackFromFirst: true
			});
			if (values === undefined) return;
			if (values === BACK) continue;
			const cluster = { id: 'test', name: name.trim(), providerId: provider.id, config: values };
			if (provider.testConnection) {
				try {
					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: `Connecting to ${cluster.name}…` },
						() =>
							provider.testConnection!(cluster, Object.freeze({ ...stringValues(provider.connectionSchema, values) }), {
								storagePath: context.globalStorageUri.fsPath,
								log: { info() {}, warn() {}, error() {}, debug() {} }
							})
					);
				} catch (error) {
					const choice = await vscode.window.showWarningMessage(
						`Could not connect to ${cluster.name}`,
						{ modal: true, detail: errorMessage(error) },
						'Save Anyway'
					);
					if (choice !== 'Save Anyway') return;
				}
			}
			const stored = await store.add({ name: cluster.name, providerId: provider.id, values, schema: provider.connectionSchema });
			await manager.refresh(stored.id);
			await tree.reveal({ kind: 'cluster', clusterId: stored.id }).then(undefined, () => undefined);
			return;
		}
	}

	async function editCluster(arg: Arg): Promise<void> {
		const clusterId = await resolveCluster(arg, 'Select the cluster to edit');
		const cluster = clusterId ? store.get(clusterId) : undefined;
		if (!cluster) return;
		const provider = await registry.ensure(cluster.providerId);
		if (!provider) {
			void vscode.window.showErrorMessage(`The provider for ${cluster.name} is not installed.`);
			return;
		}
		const title = `Edit ${cluster.name}`;
		const totalSteps = 1 + provider.connectionSchema.length;
		const otherNames = new Set(store.all().filter((c) => c.id !== cluster.id).map((c) => c.name));
		for (;;) {
			const name = await textStep(
				{ title, step: 1, totalSteps, canGoBack: false },
				{
					value: cluster.name,
					prompt: 'Cluster name',
					validate: (v) => (!v.trim() ? 'Name is required' : otherNames.has(v.trim()) ? 'A cluster with this name already exists' : undefined)
				}
			);
			if (name === undefined || name === BACK) return;
			const values = await collectFields(provider.connectionSchema, cluster.config, {
				title,
				stepOffset: 1,
				canGoBackFromFirst: true,
				storedSecrets: cluster.secretKeys
			});
			if (values === undefined) return;
			if (values === BACK) continue;
			await store.update(cluster.id, { name: name.trim(), providerId: cluster.providerId, values, schema: provider.connectionSchema });
			await manager.refresh(cluster.id);
			return;
		}
	}

	async function removeCluster(arg: Arg): Promise<void> {
		const clusterId = await resolveCluster(arg, 'Select the cluster to remove');
		const cluster = clusterId ? store.get(clusterId) : undefined;
		if (!cluster) return;
		const choice = await vscode.window.showWarningMessage(
			`Remove cluster "${cluster.name}"?`,
			{ modal: true, detail: 'Its stored credentials are deleted as well. Virtual machines on the hypervisor are not affected.' },
			'Remove'
		);
		if (choice === 'Remove') await store.remove(cluster.id);
	}

	// -----------------------------------------------------------------------------------------
	// VMs
	// -----------------------------------------------------------------------------------------

	async function createVm(arg: Arg): Promise<void> {
		const nodeRef = await resolveNode(arg);
		if (!nodeRef) return;
		const nodeName = manager.node(nodeRef.clusterId, nodeRef.nodeId)?.name ?? nodeRef.nodeId;
		try {
			const connection = await manager.connect(nodeRef.clusterId);
			const schema = await inView(() => connection.getCreateSchema(nodeRef.nodeId));
			const values = await collectFields(schema, fieldDefaults(schema), { title: `Create Virtual Machine on ${nodeName}` });
			if (!values || values === BACK) return;
			const invalid = validateValues(schema.filter((f) => !f.advanced), values);
			if (invalid) throw new Error(invalid.message);
			const vm = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Creating ${String(values.name ?? 'virtual machine')}…` },
				() => connection.createVm(nodeRef.nodeId, values)
			);
			await manager.refresh(nodeRef.clusterId);
			const ref: VmRef = { ...nodeRef, vmId: vm.id };
			await tree.reveal({ kind: 'vm', ...ref }).then(undefined, () => undefined);
			const choice = await vscode.window.showInformationMessage(`Created ${vm.name}.`, 'Start', 'Settings');
			if (choice === 'Start') await power(ref, 'start');
			if (choice === 'Settings') VmSettingsPanel.show(context.extensionUri, manager, ref);
		} catch (error) {
			await showError('Could not create the virtual machine', error);
		}
	}

	async function deleteVm(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select the virtual machine to delete');
		if (!location) return;
		const choice = await vscode.window.showWarningMessage(
			`Delete virtual machine "${location.vm.name}"?`,
			{ modal: true, detail: 'This cannot be undone. A running machine is powered off first.' },
			'Delete VM',
			'Delete VM and Disks'
		);
		if (!choice) return;
		try {
			const connection = await manager.connect(location.ref.clusterId);
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Deleting ${location.vm.name}…` },
				() => connection.deleteVm(location.ref.nodeId, location.ref.vmId, { deleteDisks: choice === 'Delete VM and Disks' })
			);
			await manager.refresh(location.ref.clusterId);
		} catch (error) {
			await showError(`Could not delete ${location.vm.name}`, error);
		}
	}

	async function connectGraphical(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to connect to');
		if (!location) return;
		const caps = location.cluster.connection?.capabilities;
		const consolesAvailable = location.vm.consoles ?? caps?.consoles ?? [];
		if (consolesAvailable.includes('vnc')) return consoles.open(location.ref, 'vnc');
		if (consolesAvailable.includes('rdp')) return consoles.open(location.ref, 'rdp');
		if (caps?.preview) return consoles.open(location.ref, 'preview');
		if (caps?.external) return openExternal(location.ref);
		void vscode.window.showInformationMessage(`${location.vm.name} has no graphical console.`);
	}

	async function connectSerial(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to connect to');
		if (!location) return;
		await consoles.open(location.ref, 'serial');
	}

	async function openExternal(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to open');
		if (!location) return;
		try {
			const connection = await manager.connect(location.ref.clusterId);
			if (!connection.openExternal) throw new Error('This hypervisor has no native viewer');
			await connection.openExternal(location.ref.nodeId, location.ref.vmId);
		} catch (error) {
			await showError(`Could not open ${location.vm.name}`, error);
		}
	}

	/** Long pastes take a while to type and are easy to trigger by accident. */
	const TYPE_CONFIRM_LENGTH = 2000;

	async function typeClipboard(): Promise<void> {
		const session = consoles.active();
		if (!session) {
			void vscode.window.showInformationMessage('Open a console first, then type the clipboard into it.');
			return;
		}
		const text = await vscode.env.clipboard.readText();
		if (!text) {
			void vscode.window.showInformationMessage('The clipboard has no text to type.');
			return;
		}
		if (text.length > TYPE_CONFIRM_LENGTH) {
			const choice = await vscode.window.showWarningMessage(
				`Type ${text.length.toLocaleString()} characters into the console?`,
				{ modal: true, detail: 'The text is sent as key presses, which takes a while for long text.' },
				'Type'
			);
			if (choice !== 'Type') return;
		}
		if (!session.typeText(text)) void vscode.window.showWarningMessage('The console is not connected.');
	}

	async function consolePower(action: PowerAction): Promise<void> {
		const session = consoles.active();
		if (!session) return;
		await power(session.ref, action);
	}

	const register = (id: string, fn: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, fn);

	return [
		register('vmm.addCluster', () => addCluster()),
		register('vmm.editCluster', (arg) => editCluster(arg)),
		register('vmm.removeCluster', (arg) => removeCluster(arg)),
		register('vmm.forgetConsoleCredentials', async (arg) => {
			const clusterId = await resolveCluster(arg, 'Select the cluster whose console sign-in to forget');
			if (!clusterId) return;
			await credentials.forget(clusterId);
			void vscode.window.showInformationMessage('Console sign-in forgotten. You will be asked again on the next connect.');
		}),
		register('vmm.reconnectCluster', async (arg) => {
			const clusterId = await resolveCluster(arg, 'Select the cluster to reconnect');
			if (clusterId) await inView(() => manager.reconnect(clusterId));
		}),
		register('vmm.refresh', (arg) => inView(() => manager.refresh(asClusterId(arg)))),
		register('vmm.openOverview', () => OverviewPanel.show(context.extensionUri, manager)),
		register('vmm.installProviders', (providerId) =>
			vscode.commands.executeCommand(
				'workbench.extensions.search',
				typeof providerId === 'string' ? `vm-manager-${providerId}` : 'VM Manager provider'
			)
		),
		register('vmm.showWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false)),
		register('vmm.createVm', (arg) => createVm(arg)),
		register('vmm.editVm', async (arg) => {
			const location = await resolveVm(arg, 'Select a virtual machine to configure');
			if (location) VmSettingsPanel.show(context.extensionUri, manager, location.ref);
		}),
		register('vmm.ejectMedia', (arg) => ejectMedia(arg)),
		register('vmm.changeMedia', (arg) => changeMedia(arg)),
		register('vmm.deleteVm', (arg) => deleteVm(arg)),
		register('vmm.start', (arg) => power(arg, 'start')),
		register('vmm.shutdown', (arg) => power(arg, 'shutdown')),
		register('vmm.reboot', (arg) => power(arg, 'reboot')),
		register('vmm.stop', (arg) => power(arg, 'stop')),
		register('vmm.connectGraphical', (arg) => connectGraphical(arg)),
		register('vmm.connectSerial', (arg) => connectSerial(arg)),
		register('vmm.openExternal', (arg) => openExternal(arg)),
		register('vmm.copyId', async (arg) => {
			const ref = asVmRef(arg);
			if (ref) await vscode.env.clipboard.writeText(ref.vmId);
		}),
		register('vmm.console.sendCtrlAltDel', () => consoles.active()?.sendCommand('ctrlAltDel')),
		register('vmm.console.toggleScaling', () => consoles.active()?.sendCommand('toggleScaling')),
		register('vmm.console.typeClipboard', () => typeClipboard()),
		register('vmm.console.reconnect', () => consoles.active()?.connect()),
		register('vmm.console.openInNewWindow', () => consoles.moveToNewWindow()),
		register('vmm.console.shutdown', () => consolePower('shutdown')),
		register('vmm.console.reboot', () => consolePower('reboot')),
		register('vmm.console.stop', () => consolePower('stop'))
	];
}

function stringValues(schema: FieldSchema[], values: Record<string, unknown>): Record<string, string | undefined> {
	const result: Record<string, string | undefined> = {};
	for (const field of schema) {
		if (field.secret || field.type === 'password') {
			const v = values[field.key];
			result[field.key] = v === undefined || v === '' ? undefined : String(v);
		}
	}
	return result;
}
