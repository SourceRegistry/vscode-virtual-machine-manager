import * as path from 'node:path';
import * as vscode from 'vscode';
import { fieldDefaults, validateValues, type ClusterConnection, type DiskDevice, type FieldSchema, type PowerAction, type VmInfo } from '@vmm/sdk';
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
import { VmDashboardPanel } from '../webview/VmDashboardPanel';
import { VmSettingsPanel } from '../webview/VmSettingsPanel';
import { errorMessage, log, showError } from '../util/log';
import * as snapshotFlow from '../snapshots/flow';
import { manageDisks as manageDisksFlow } from '../disks/flow';
import { addSshForward, addToSshConfig, connectSsh, removeFromSshConfig } from '../ssh/connect';
import { copyFileFromGuest, copyFileToGuest, runCommandInGuest } from '../guest/commands';
import { deleteVmDetail } from '../../shared/deleteDetail';
import { withDelayedProgress } from '../util/progress';
import { matchesQuery } from '../../shared/vmSearch';
import { OPERATION_LABEL, OPERATION_TITLE, allowedDuring } from '../../shared/operations';
import { operationText } from '../../shared/countdown';
import { FAVORITES_LABEL, groupNameProblem, sameName, type GroupBy } from '../../shared/treeGroups';
import { FAVORITES, groupBySetting } from '../tree/VmTreeProvider';
import type { VmActivity } from '../activity/VmActivity';
import type { VmMarksStore } from '../tree/VmMarksStore';
import type { VmControl } from '../api/VmControl';

export const WALKTHROUGH_ID = 'sourceregistry.vm-manager#gettingStarted';

export interface CommandDeps {
	context: vscode.ExtensionContext;
	store: ClusterStore;
	registry: ProviderRegistry;
	manager: ConnectionManager;
	tree: VmTreeProvider;
	/** The Groups view under the main one. */
	groupsTree: VmTreeProvider;
	consoles: ConsoleManager;
	credentials: RdpCredentialStore;
	activity: VmActivity;
	marks: VmMarksStore;
	control: VmControl;
}

type Arg = unknown;

// ---------------------------------------------------------------------------------------------
// Argument resolution: commands accept tree elements, VmRefs (overview), a machine's name or { vm: name }
// (keybindings, tasks, other extensions), or nothing (palette).
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
	const { context, store, registry, manager, tree, groupsTree, consoles, credentials, activity, marks, control } = deps;

	/** A name (or `cluster/name`, or an API id) given as the argument: `"web-01"` or `{ "vm": "web-01" }`. */
	function namedVm(arg: Arg): string | undefined {
		if (typeof arg === 'string') return arg;
		const vm = asRecord(arg)?.vm;
		return typeof vm === 'string' ? vm : undefined;
	}

	async function loadAll(): Promise<void> {
		await Promise.all(manager.clusters().map((c) => manager.ensureLoaded(c.cluster.id)));
	}

	async function resolveVm(arg: Arg, placeholder: string, filter: (l: VmLocation) => boolean = () => true): Promise<VmLocation | undefined> {
		const named = namedVm(arg);
		if (named !== undefined) {
			try {
				return await control.resolve(named);
			} catch (error) {
				void vscode.window.showErrorMessage(errorMessage(error));
				return undefined;
			}
		}
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

	/** Find a VM by name, id, IP or MAC across all clusters; picking one reveals it and opens its details. */
	async function searchVms(): Promise<void> {
		await loadAll();
		const all = manager.allVms();
		if (!all.length) {
			void vscode.window.showInformationMessage('No virtual machines to search.');
			return;
		}
		type SearchItem = vscode.QuickPickItem & { location: VmLocation };
		const quickPick = vscode.window.createQuickPick<SearchItem>();
		quickPick.placeholder = 'Search by name, ID, IP address or MAC address';
		quickPick.matchOnDescription = quickPick.matchOnDetail = false;
		const items: SearchItem[] = all.map((location) => {
			const { vm } = location;
			const addresses = [...(vm.ipAddresses ?? []), ...(vm.macAddresses ?? [])];
			return {
				label: `${vm.displayId ? `#${vm.displayId}  ` : ''}${vm.name}`,
				description: stateLabel(vm.state),
				detail: [`${location.cluster.cluster.name} › ${location.node.name}`, ...addresses].join('  ·  '),
				// Filtered by matchesQuery below; VS Code's own label filter would hide IP and MAC matches.
				alwaysShow: true,
				location
			};
		});
		const filter = () => { quickPick.items = items.filter((item) => matchesQuery(quickPick.value, item.location.vm, [item.location.cluster.cluster.name, item.location.node.name])); };
		quickPick.onDidChangeValue(filter);
		filter();
		const picked = await new Promise<SearchItem | undefined>((resolve) => {
			quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
			quickPick.onDidHide(() => resolve(undefined));
			quickPick.show();
		});
		quickPick.dispose();
		if (!picked) return;
		await tree.revealVm(picked.location.ref).then(undefined, () => undefined);
		VmDashboardPanel.show(context.extensionUri, manager, picked.location.ref);
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

	async function resolveNode(arg: Arg, capability: 'create' | 'adopt' | 'importFolder' = 'create'): Promise<{ clusterId: string; nodeId: string } | undefined> {
		const ref = asNodeRef(arg);
		if (ref) return ref;
		await withDelayedProgress('Connecting to clusters…', () => loadAll());
		const clusterFilter = asClusterId(arg);
		const nodes = manager
			.clusters()
			.filter((c) => c.connection?.capabilities[capability] && (!clusterFilter || c.cluster.id === clusterFilter))
			.flatMap((c) => c.nodes.filter((n) => n.status === 'online').map((n) => ({ cluster: c, node: n })));
		if (!nodes.length) {
			void vscode.window.showInformationMessage(capability === 'create' ? 'No connected node supports creating virtual machines.' : 'No connected node supports this.');
			return undefined;
		}
		if (nodes.length === 1) return { clusterId: nodes[0].cluster.cluster.id, nodeId: nodes[0].node.id };
		const picked = await vscode.window.showQuickPick(
			nodes.map((n) => ({
				label: n.node.name,
				description: n.cluster.cluster.name,
				ref: { clusterId: n.cluster.cluster.id, nodeId: n.node.id }
			})),
			{ placeHolder: 'Select the node' }
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
		const timeout = location.cluster.connection?.capabilities.shutdownTimeoutSeconds;
		void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${OPERATION_TITLE[action]} ${name}` }, (progress) => {
			// The status bar counts down a graceful shutdown, like the tree.
			const started = Date.now();
			const timer = setInterval(() => {
				const extra = operationText(action, started, Date.now(), timeout).slice(OPERATION_LABEL[action].length).trim();
				if (extra) progress.report({ message: extra });
			}, 1000);
			return task.catch(() => undefined).finally(() => clearInterval(timer));
		});
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
			activity.record(location.ref, `Ejected ${drive.path ?? 'the media'} from ${drive.label}`);
			await manager.refresh(location.ref.clusterId);
			void vscode.window.setStatusBarMessage(`Ejected ${drive.path ? path.basename(drive.path) : 'media'} from ${location.vm.name}`, 4000);
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
			let image: string | undefined;
			if (connection.capabilities.remotePaths) {
				// The image lies on the host: this computer's file dialog cannot show it.
				image = (await vscode.window.showInputBox({ title: `Insert into ${location.vm.name}`, prompt: 'Path of the image on the host', placeHolder: '/var/lib/images/install.iso', ignoreFocusOut: true }))?.trim();
			} else {
				image = (
					await vscode.window.showOpenDialog({
						title: `Insert into ${location.vm.name}`,
						canSelectMany: false,
						filters: { 'Disk images': ['iso', 'img'], 'All files': ['*'] }
					})
				)?.[0]?.fsPath;
			}
			if (!image) return;
			await connection.insertMedia(location.ref.nodeId, location.ref.vmId, drive.id, image);
			activity.record(location.ref, `Inserted ${image} into ${drive.label}`);
			await manager.refresh(location.ref.clusterId);
			void vscode.window.setStatusBarMessage(`Inserted ${path.basename(image)} into ${location.vm.name}`, 4000);
		} catch (error) {
			await showError(`Could not change the media of ${location.vm.name}`, error);
		}
	}

	async function manageDisks(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to manage the disks of', (l) => !!l.cluster.connection?.capabilities.diskOperations?.length && l.vm.origin !== 'adopted');
		if (!location) return;
		const diskId = asRecord(arg)?.diskId;
		await manageDisksFlow({ manager, activity }, location, typeof diskId === 'string' ? diskId : undefined);
	}

	// -----------------------------------------------------------------------------------------
	// SSH
	// -----------------------------------------------------------------------------------------

	async function connectWithSsh(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to connect to over SSH', (l) => !!l.cluster.connection?.capabilities.details && l.vm.state === 'running');
		if (location) await connectSsh(manager, context.globalState, location);
	}

	async function forwardSsh(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to forward SSH for', (l) => !!l.cluster.connection?.capabilities.forwards);
		if (location) await addSshForward(manager, location);
	}

	// -----------------------------------------------------------------------------------------
	// Guest (through the guest agent)
	// -----------------------------------------------------------------------------------------

	async function guest(arg: Arg, what: 'run' | 'to' | 'from'): Promise<void> {
		const capable = (l: VmLocation) => l.vm.state === 'running' && !!(what === 'run' ? l.cluster.connection?.capabilities.guestExec : l.cluster.connection?.capabilities.guestFiles);
		const placeholder = { run: 'Select a running virtual machine to run a command in', to: 'Select a running virtual machine to copy a file to', from: 'Select a running virtual machine to copy a file from' }[what];
		const location = await resolveVm(arg, placeholder, capable);
		if (!location) return;
		if (location.vm.state !== 'running') {
			void vscode.window.showInformationMessage(`"${location.vm.name}" is not running.`);
			return;
		}
		const record = (text: string, level?: 'info' | 'warn' | 'error') => activity.record(location.ref, text, level);
		if (what === 'run') await runCommandInGuest(context, manager, location, record);
		else if (what === 'to') await copyFileToGuest(context, manager, location, record);
		else await copyFileFromGuest(context, manager, location, record);
	}

	// -----------------------------------------------------------------------------------------
	// Clone
	// -----------------------------------------------------------------------------------------

	async function cloneVm(arg: Arg, fromTemplate = false): Promise<void> {
		const location = await resolveVm(arg, fromTemplate ? 'Select a template' : 'Select a virtual machine to clone', (l) => !!l.cluster.connection?.capabilities.clone && (!fromTemplate || !!l.vm.template));
		if (!location) return;
		const caps = location.cluster.connection?.capabilities;
		if (caps?.cloneNeedsStopped && location.vm.state !== 'stopped') {
			void vscode.window.showInformationMessage(`Shut down "${location.vm.name}" before cloning it: a running machine keeps changing its disks.`);
			return;
		}
		const name = await vscode.window.showInputBox({
			title: fromTemplate ? `New machine from ${location.vm.name}` : `Clone ${location.vm.name}`,
			prompt: 'Name of the copy. It gets its own disks and network address; snapshots, port forwards and passed-through devices are not copied.',
			value: fromTemplate ? location.vm.name.replace(/\s*template\s*$/i, '').trim() || `${location.vm.name} (new)` : `${location.vm.name} (clone)`
		});
		if (name === undefined) return;
		try {
			const connection = await manager.connect(location.ref.clusterId);
			if (!connection.cloneVm) return;
			const copy = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Cloning ${location.vm.name}… (large disks take a while)` },
				() => connection.cloneVm!(location.ref.nodeId, location.ref.vmId, name.trim())
			);
			activity.record(location.ref, `Cloned into "${copy.name}"`);
			activity.record({ ...location.ref, vmId: copy.id }, `Created as a clone of "${location.vm.name}"`);
			await manager.refresh(location.ref.clusterId);
			const choice = await vscode.window.showInformationMessage(`"${copy.name}" is ready.`, 'Start');
			if (choice === 'Start') await power({ ...location.ref, vmId: copy.id }, 'start');
		} catch (error) {
			await showError(`Could not clone ${location.vm.name}`, error);
		}
	}

	async function setTemplate(arg: Arg, template: boolean): Promise<void> {
		const location = await resolveVm(arg, template ? 'Select a virtual machine to turn into a template' : 'Select a template to turn back into a VM', (l) => !!l.cluster.connection?.capabilities.templates && !!l.vm.template === !template);
		if (!location) return;
		if (location.vm.state !== 'stopped') {
			void vscode.window.showInformationMessage(`Shut down "${location.vm.name}" first.`);
			return;
		}
		if (template) {
			const choice = await vscode.window.showWarningMessage(`Turn "${location.vm.name}" into a template? It can no longer be started; new machines are created from it.`, { modal: true }, 'Convert');
			if (choice !== 'Convert') return;
		}
		try {
			const connection = await manager.connect(location.ref.clusterId);
			await connection.setTemplate?.(location.ref.nodeId, location.ref.vmId, template);
			await manager.refresh(location.ref.clusterId);
		} catch (error) {
			await showError(`Could not change ${location.vm.name}`, error);
		}
	}

	// -----------------------------------------------------------------------------------------
	// Snapshots
	// -----------------------------------------------------------------------------------------

	const canSnapshot = (l: VmLocation) => !!l.cluster.connection?.capabilities.snapshots;

	async function takeSnapshot(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to snapshot', canSnapshot);
		if (!location) return;
		const snapshot = await snapshotFlow.takeSnapshot(manager, location);
		if (snapshot) activity.record(location.ref, `Snapshot "${snapshot.name}" taken${snapshot.includesMemory ? ' (with memory)' : ''}`);
	}

	async function revertSnapshot(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to revert', canSnapshot);
		if (!location) return;
		const snapshot = await snapshotFlow.pickSnapshot(manager, location, `Revert ${location.vm.name} to…`);
		if (snapshot && (await snapshotFlow.revertSnapshot(manager, location, snapshot))) activity.record(location.ref, `Reverted to snapshot "${snapshot.name}"`);
	}

	async function deleteSnapshot(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to delete a snapshot of', canSnapshot);
		if (!location) return;
		const snapshot = await snapshotFlow.pickSnapshot(manager, location, `Delete a snapshot of ${location.vm.name}`);
		if (snapshot && (await snapshotFlow.deleteSnapshot(manager, location, snapshot))) activity.record(location.ref, `Snapshot "${snapshot.name}" deleted`);
	}

	// -----------------------------------------------------------------------------------------
	// Log, favorites, groups, grouping
	// -----------------------------------------------------------------------------------------

	/** The machines a tree command acts on: every selected one when the clicked row is part of the selection. */
	function selectedRefs(location: VmLocation, selected: unknown): VmRef[] {
		const refs = Array.isArray(selected) ? selected.map(asVmRef).filter((r): r is VmRef => !!r) : [];
		const same = (a: VmRef, b: VmRef) => a.clusterId === b.clusterId && a.nodeId === b.nodeId && a.vmId === b.vmId;
		if (!refs.some((r) => same(r, location.ref))) return [location.ref];
		return refs.filter((r, i) => refs.findIndex((o) => same(o, r)) === i);
	}

	/** A group named by the argument: a group row, `"web"` or `{ "group": "web" }`; asks when there is none. */
	async function resolveGroup(arg: Arg, placeholder: string): Promise<string | undefined> {
		const a = asRecord(arg);
		const named = typeof arg === 'string' ? arg : typeof a?.group === 'string' ? a.group : a?.kind === 'group' && typeof a.id === 'string' ? groupsTree.groupName(a.id) : undefined;
		const groups = marks.groups();
		if (named !== undefined) {
			const found = groups.find((g) => sameName(g, named));
			if (!found) void vscode.window.showErrorMessage(`There is no group called "${named}".`);
			return found;
		}
		if (!groups.length) {
			void vscode.window.showInformationMessage('There are no groups yet.');
			return undefined;
		}
		return vscode.window.showQuickPick(groups, { placeHolder: placeholder });
	}

	async function askGroupName(title: string, value = '', renaming?: string): Promise<string | undefined> {
		const name = await vscode.window.showInputBox({
			title,
			value,
			placeHolder: 'web servers',
			validateInput: (input) => groupNameProblem(input, marks.groups(), renaming)
		});
		return name?.trim() ? name : undefined;
	}

	async function newGroup(): Promise<void> {
		const name = await askGroupName('New Group');
		if (!name) return;
		const created = await marks.createGroup(name);
		void vscode.window.setStatusBarMessage(`Group "${created}" made: drag machines into it, or use Add to Group… on a machine.`, 5000);
	}

	async function addToGroup(arg: Arg, selected: unknown): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to add to a group');
		if (!location) return;
		const refs = selectedRefs(location, selected);
		const named = asRecord(arg)?.group;
		let group = typeof named === 'string' ? named : undefined;
		if (!group) {
			const inAll = (g: string) => refs.every((r) => marks.groupsOf(r).some((m) => sameName(m, g)));
			const NEW = '$(new-folder) New Group…';
			const picked = await vscode.window.showQuickPick(
				[...marks.groups().filter((g) => !inAll(g)).map((g) => ({ label: g, iconPath: new vscode.ThemeIcon('folder') })), { label: NEW, alwaysShow: true }],
				{ placeHolder: refs.length > 1 ? `Add ${refs.length} machines to` : `Add ${location.vm.name} to` }
			);
			if (!picked) return;
			group = picked.label === NEW ? await askGroupName('New Group') : picked.label;
			if (!group) return;
		}
		if (sameName(group, FAVORITES_LABEL)) return marks.setFavorite(refs, true);
		await marks.addToGroup(refs, group);
	}

	/** From the Groups view the row says which group; elsewhere the user picks one of the machine's groups. */
	async function removeFromGroup(arg: Arg, selected: unknown): Promise<void> {
		const parent = asRecord(arg)?.parent;
		const location = await resolveVm(arg, 'Select a virtual machine to remove from a group', (l) => marks.groupsOf(l.ref).length > 0);
		if (!location) return;
		const refs = selectedRefs(location, selected);
		if (parent === FAVORITES) return marks.setFavorite(refs, false);
		const named = asRecord(arg)?.group;
		let group = typeof parent === 'string' ? groupsTree.groupName(parent) : typeof named === 'string' ? named : undefined;
		if (!group) {
			const groups = marks.groupsOf(location.ref);
			group = groups.length === 1 ? groups[0] : await vscode.window.showQuickPick(groups, { placeHolder: `Remove ${location.vm.name} from` });
		}
		if (group) await marks.removeFromGroup(refs, group);
	}

	async function renameGroup(arg: Arg): Promise<void> {
		const group = await resolveGroup(arg, 'Select a group to rename');
		if (!group) return;
		const name = await askGroupName(`Rename Group "${group}"`, group, group);
		if (name) await marks.renameGroup(group, name);
	}

	async function deleteGroup(arg: Arg): Promise<void> {
		const group = await resolveGroup(arg, 'Select a group to delete');
		if (!group) return;
		const choice = await vscode.window.showWarningMessage(`Delete the group "${group}"?`, { modal: true, detail: 'Its machines are not touched; they only leave the group.' }, 'Delete Group');
		if (choice) await marks.deleteGroup(group);
	}

	async function showLog(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select a virtual machine to show the log of');
		if (location) await activity.show(location.ref);
	}

	async function favorite(arg: Arg, selected: unknown, on: boolean): Promise<void> {
		const location = await resolveVm(arg, on ? 'Select a virtual machine to add to Favorites' : 'Select a virtual machine to remove from Favorites', (l) => marks.isFavorite(l.ref) !== on);
		if (location) await marks.setFavorite(selectedRefs(location, selected), on);
	}

	async function chooseGrouping(): Promise<void> {
		const current = groupBySetting();
		const items: Array<vscode.QuickPickItem & { value: GroupBy }> = [
			{ label: 'Cluster', description: 'cluster › node › machine', value: 'cluster' },
			{ label: 'Group', description: 'your groups; a machine in two groups is in both', value: 'group' },
			{ label: 'State', description: 'running, off, …', value: 'state' }
		].map((item) => ({ ...item, label: `${item.value === current ? '$(check) ' : ''}${item.label}` })) as Array<vscode.QuickPickItem & { value: GroupBy }>;
		const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Group the virtual machines by' });
		if (picked) await vscode.workspace.getConfiguration('vmm').update('tree.groupBy', picked.value, vscode.ConfigurationTarget.Global);
	}

	/**
	 * For launch.json inputs and other extensions: `{ "vm": "web-01", "ssh": true, "timeout": 120 }` gives the host
	 * (or with `port: true` the port) to reach it on; waits up to `timeout` seconds for one. Errors are shown and
	 * returned as undefined, which cancels a launch.
	 */
	async function vmAddress(arg: Arg, part: 'host' | 'port'): Promise<string | undefined> {
		const options = asRecord(arg) ?? {};
		const name = namedVm(arg);
		if (!name) {
			void vscode.window.showErrorMessage('Say which machine: "args": { "vm": "<name>" }.');
			return undefined;
		}
		const ssh = part === 'port' || options.ssh === true;
		const timeoutMs = Math.max(0, Number(options.timeout ?? 60)) * 1000;
		try {
			const found = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: ssh ? `Waiting for SSH on ${name}…` : `Waiting for an address of ${name}…`, cancellable: true },
				(_progress, token) => control.address(name, { ssh, timeoutMs }, token)
			);
			if (!found) throw new Error(ssh ? `No SSH server answered on ${name}.` : `${name} has no IP address yet (is it running, with the guest agent?).`);
			return part === 'host' ? found.host : String(found.port ?? 22);
		} catch (error) {
			void vscode.window.showErrorMessage(errorMessage(error));
			return undefined;
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
			const vm: VmInfo = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Creating ${String(values.name ?? 'virtual machine')}…` },
				(progress) => {
					let shown = 0;
					return connection.createVm(nodeRef.nodeId, values, (update) => {
						// The notification wants increments, the provider reports how far along it is.
						const target = update.fraction === undefined ? shown : Math.max(shown, Math.min(1, update.fraction));
						progress.report({ message: update.message, increment: (target - shown) * 100 });
						shown = target;
					});
				}
			);
			await manager.refresh(nodeRef.clusterId);
			const ref: VmRef = { ...nodeRef, vmId: vm.id };
			activity.record(ref, 'Created in VS Code');
			await tree.revealVm(ref).then(undefined, () => undefined);
			const choice = await vscode.window.showInformationMessage(`Created ${vm.name}.`, 'Start', 'Settings');
			if (choice === 'Start') await power(ref, 'start');
			if (choice === 'Settings') VmSettingsPanel.show(context.extensionUri, manager, ref);
		} catch (error) {
			await showError('Could not create the virtual machine', error);
		}
	}

	const OPEN_DISPLAY = 'Open Display';
	const OPEN_SERIAL = 'Open Serial Console';

	async function attachRunningVm(arg: Arg): Promise<void> {
		const nodeRef = await resolveNode(arg, 'adopt');
		if (!nodeRef) return;
		try {
			const clusterName = manager.clusters().find((c) => c.cluster.id === nodeRef.clusterId)?.cluster.name ?? 'the cluster';
			const connection = await withDelayedProgress(`Connecting to ${clusterName}…`, () => manager.connect(nodeRef.clusterId));
			if (!connection.scanExternalVms || !connection.adoptExternalVm) return;
			const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Looking for running virtual machines on ${clusterName}…` }, () =>
				connection.scanExternalVms!(nodeRef.nodeId)
			);
			if (!found.length) {
				void vscode.window.showInformationMessage('No running virtual machines were found that VM Manager does not already know.');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				found.map((f) => ({
					label: f.name,
					description: f.detail,
					detail: f.controllable ? 'Can be fully managed' : f.hint,
					picked: f.controllable,
					id: f.id
				})),
				{ title: 'Attach to running virtual machines', placeHolder: 'Select the machines to attach to', canPickMany: true, matchOnDescription: true }
			);
			if (!picked?.length) return;
			const warnings: string[] = [];
			let last: VmInfo | undefined;
			// Attaching talks to each machine's control channel (over ssh on a remote host): say so while it runs.
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: picked.length === 1 ? `Attaching to ${picked[0]!.label}…` : `Attaching to ${picked.length} virtual machines…` }, async (progress) => {
				for (const [index, item] of picked.entries()) {
					if (picked.length > 1) progress.report({ message: `${item.label} (${index + 1} of ${picked.length})`, increment: 100 / picked.length });
					const result = await connection.adoptExternalVm!(nodeRef.nodeId, item.id);
					last = result.vm;
					if (result.warning) warnings.push(result.warning);
				}
				progress.report({ message: 'Updating the list…' });
				await manager.refresh(nodeRef.clusterId);
			});
			if (last) await tree.reveal({ kind: 'vm', ...nodeRef, vmId: (last as VmInfo).id }).then(undefined, () => undefined);
			const summary = picked.length === 1 && last ? `Attached to ${last.name}.` : `Attached to ${picked.length} virtual machines.`;
			// One VM: offer its display / serial console right away, when the process exposes them.
			const offered = picked.length === 1 && last ? (last.consoles ?? []) : [];
			const actions = [...(offered.includes('vnc') ? [OPEN_DISPLAY] : []), ...(offered.includes('serial') ? [OPEN_SERIAL] : [])];
			const choice = warnings.length
				? await vscode.window.showWarningMessage(`${summary} ${warnings.join(' ')}`, ...actions)
				: await vscode.window.showInformationMessage(summary, ...actions);
			if (last && choice) await consoles.open({ ...nodeRef, vmId: last.id }, choice === OPEN_DISPLAY ? 'vnc' : 'serial');
		} catch (error) {
			await showError('Could not attach to the running virtual machine', error);
		}
	}

	async function importFromFolder(arg: Arg): Promise<void> {
		const nodeRef = await resolveNode(arg, 'importFolder');
		if (!nodeRef) return;
		try {
			const connection = await manager.connect(nodeRef.clusterId);
			if (!connection.scanImportFolder || !connection.importFromFolder) return;
			const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Folder with virtual machines or disk images', openLabel: 'Scan Folder' });
			if (!folder?.[0]) return;
			const dir = folder[0].fsPath;
			const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Scanning ${path.basename(dir)}…` }, () =>
				connection.scanImportFolder!(nodeRef.nodeId, dir)
			);
			if (!found.length) {
				void vscode.window.showInformationMessage('No disk images or virtual machine definitions that are not yet imported were found in that folder.');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				found.map((f) => ({ label: f.name, description: f.source, detail: f.detail, picked: true, id: f.id })),
				{ title: 'Import virtual machines', placeHolder: 'Select the machines to import', canPickMany: true, matchOnDetail: true }
			);
			if (!picked?.length) return;
			const mode = await vscode.window.showQuickPick(
				[
					{ label: 'Use the disks where they are', description: 'Fast, no extra space. The VM works on the original files.', copy: false },
					{ label: 'Copy the disks', description: 'Keeps the originals untouched. Needs the space and time to copy.', copy: true }
				],
				{ title: 'Import virtual machines', placeHolder: 'How should the disks be imported?' }
			);
			if (!mode) return;
			const imported = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Importing ${picked.length} virtual machine${picked.length === 1 ? '' : 's'}…` },
				() => connection.importFromFolder!(nodeRef.nodeId, dir, picked.map((p) => p.id), { copy: mode.copy })
			);
			await manager.refresh(nodeRef.clusterId);
			if (imported[0]) await tree.reveal({ kind: 'vm', ...nodeRef, vmId: imported[0].id }).then(undefined, () => undefined);
			void vscode.window.showInformationMessage(`Imported ${imported.map((v) => v.name).join(', ')}.`);
		} catch (error) {
			await showError('Could not import the virtual machines', error);
		}
	}

	/** A VM that is gone leaves nothing to show: close its details, settings and consoles (display and serial). */
	function closeViews(ref: VmRef): void {
		VmDashboardPanel.closeFor(ref);
		VmSettingsPanel.closeFor(ref);
		consoles.closeFor(ref);
	}

	/** Stops tracking an attached VM. The process and its disks are not touched. */
	async function detachFrom(location: VmLocation): Promise<void> {
		const detach = await vscode.window.showWarningMessage(`Detach from "${location.vm.name}"?`, { modal: true, detail: 'The virtual machine keeps running; it is only removed from this list. You can attach to it again.' }, 'Detach');
		if (!detach) return;
		try {
			const connection = await manager.connect(location.ref.clusterId);
			await connection.deleteVm(location.ref.nodeId, location.ref.vmId, { deleteDisks: false });
			manager.forgetVm(location.ref);
			closeViews(location.ref);
			await manager.refresh(location.ref.clusterId);
			void vscode.window.setStatusBarMessage(`Detached from ${location.vm.name}`, 4000);
		} catch (error) {
			await showError(`Could not detach from ${location.vm.name}`, error);
		}
	}

	async function detachVm(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select the attached virtual machine to detach from', (l) => l.vm.origin === 'adopted');
		if (location) await detachFrom(location);
	}

	async function deleteVm(arg: Arg): Promise<void> {
		const location = await resolveVm(arg, 'Select the virtual machine to delete');
		if (!location) return;
		if (location.vm.origin === 'adopted') return detachFrom(location);
		const snapshots = location.cluster.connection?.capabilities.snapshots ? await snapshotFlow.listSnapshots(manager, location).then((list) => list.length, () => undefined) : undefined;
		const choice = await vscode.window.showWarningMessage(
			`Delete virtual machine "${location.vm.name}"?`,
			{ modal: true, detail: deleteVmDetail(snapshots) },
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
			manager.forgetVm(location.ref);
			await marks.forget(location.ref);
			closeViews(location.ref);
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
		// A VM that disappears for any reason (deleted in the hypervisor's own tools, an attached process that
		// exited, a removed cluster) takes its tabs with it, not only one deleted from here. The user is only
		// told when they did not cause it (a power-off or delete from here explains it).
		manager.onDidRemoveVms((gone) => {
			for (const vm of gone) {
				closeViews(vm.ref);
				if (vm.expected) continue;
				const cluster = manager.cluster(vm.ref.clusterId)?.cluster.name;
				if (vm.adopted) {
					void vscode.window.showWarningMessage(`"${vm.name}" was detached: the attached virtual machine is no longer running. Its tabs were closed.`);
				} else {
					void vscode.window.showInformationMessage(`"${vm.name}" no longer exists${cluster ? ` on ${cluster}` : ''}. Its tabs were closed.`);
				}
			}
		}),
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
		register('vmm.cancelConnect', (arg) => {
			const clusterId = asClusterId(arg);
			if (clusterId) manager.cancelConnect(clusterId);
		}),
		register('vmm.signOut', async (arg) => {
			const clusterId = await resolveCluster(arg, 'Select the cluster to sign out of');
			if (clusterId) await inView(() => manager.signOut(clusterId));
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
		register('vmm.attachRunningVm', (arg) => attachRunningVm(arg)),
		register('vmm.importFromFolder', (arg) => importFromFolder(arg)),
		register('vmm.searchVms', () => searchVms()),
		register('vmm.openVmDashboard', async (arg) => {
			const location = await resolveVm(arg, 'Select a virtual machine to show the details of');
			if (location) VmDashboardPanel.show(context.extensionUri, manager, location.ref);
		}),
		register('vmm.editVm', async (arg) => {
			const location = await resolveVm(arg, 'Select a virtual machine to configure');
			if (location) VmSettingsPanel.show(context.extensionUri, manager, location.ref);
		}),
		register('vmm.ejectMedia', (arg) => ejectMedia(arg)),
		register('vmm.changeMedia', (arg) => changeMedia(arg)),
		register('vmm.manageDisks', (arg) => manageDisks(arg)),
		register('vmm.connectSsh', (arg) => connectWithSsh(arg)),
		register('vmm.addSshForward', (arg) => forwardSsh(arg)),
		register('vmm.runInGuest', (arg) => guest(arg, 'run')),
		register('vmm.copyToGuest', (arg) => guest(arg, 'to')),
		register('vmm.copyFromGuest', (arg) => guest(arg, 'from')),
		register('vmm.addSshConfigEntries', () => addToSshConfig(manager, context.globalState)),
		register('vmm.removeSshConfigEntries', () => removeFromSshConfig()),
		register('vmm.cloneVm', (arg) => cloneVm(arg)),
		register('vmm.convertToTemplate', (arg) => setTemplate(arg, true)),
		register('vmm.convertToVm', (arg) => setTemplate(arg, false)),
		register('vmm.createFromTemplate', (arg) => cloneVm(arg, true)),
		register('vmm.takeSnapshot', (arg) => takeSnapshot(arg)),
		register('vmm.revertSnapshot', (arg) => revertSnapshot(arg)),
		register('vmm.deleteSnapshot', (arg) => deleteSnapshot(arg)),
		register('vmm.deleteVm', (arg) => deleteVm(arg)),
		register('vmm.detachVm', (arg) => detachVm(arg)),
		register('vmm.start', (arg) => power(arg, 'start')),
		register('vmm.shutdown', (arg) => power(arg, 'shutdown')),
		register('vmm.reboot', (arg) => power(arg, 'reboot')),
		register('vmm.stop', (arg) => power(arg, 'stop')),
		register('vmm.connectGraphical', (arg) => connectGraphical(arg)),
		register('vmm.connectSerial', (arg) => connectSerial(arg)),
		register('vmm.openExternal', (arg) => openExternal(arg)),
		register('vmm.showVmLog', (arg) => showLog(arg)),
		register('vmm.addToFavorites', (arg, selected) => favorite(arg, selected, true)),
		register('vmm.removeFromFavorites', (arg, selected) => favorite(arg, selected, false)),
		register('vmm.addToGroup', (arg, selected) => addToGroup(arg, selected)),
		register('vmm.removeFromGroup', (arg, selected) => removeFromGroup(arg, selected)),
		register('vmm.newGroup', () => newGroup()),
		register('vmm.renameGroup', (arg) => renameGroup(arg)),
		register('vmm.deleteGroup', (arg) => deleteGroup(arg)),
		register('vmm.groupBy', () => chooseGrouping()),
		register('vmm.getVmAddress', (arg) => vmAddress(arg, 'host')),
		register('vmm.getVmSshPort', (arg) => vmAddress(arg, 'port')),
		register('vmm.copyId', async (arg) => {
			const ref = asVmRef(arg);
			if (ref) await vscode.env.clipboard.writeText(ref.vmId);
		}),
		register('vmm.console.sendCtrlAltDel', () => consoles.active()?.sendCommand('ctrlAltDel')),
		register('vmm.console.toggleScaling', () => consoles.active()?.sendCommand('toggleScaling')),
		register('vmm.console.typeClipboard', () => typeClipboard()),
		register('vmm.console.refresh', () => consoles.active()?.sendCommand('refresh')),
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
