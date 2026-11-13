import * as vscode from 'vscode';
import type { DiskSizeAnswer, DiskSizeRequest, OverviewCommand, VmRef } from '../../shared/protocol';
import { bytesProblem } from '../../shared/disks';
import type { ConnectionManager } from '../clusters/ConnectionManager';
import { browserUrl, sshCommand } from '../../shared/forwards';
import { deleteSnapshot, listSnapshots, revertSnapshot, takeSnapshot } from '../snapshots/flow';
import { panelIcon, renderHtml, WebviewChannel, webviewOptions } from './WebviewHost';

export const VM_DASHBOARD_VIEW_TYPE = 'vmm.vmDashboard';

/** Commands the page may run, always on its own VM. */
const ALLOWED_COMMANDS = new Set<OverviewCommand>([
	'vmm.manageDisks',
	'vmm.start',
	'vmm.shutdown',
	'vmm.reboot',
	'vmm.stop',
	'vmm.connectGraphical',
	'vmm.connectSerial',
	'vmm.openExternal',
	'vmm.editVm',
	'vmm.ejectMedia',
	'vmm.changeMedia'
]);

/** One dashboard tab per VM: hardware inventory and live charts. */
export class VmDashboardPanel implements vscode.Disposable {
	private static readonly panels = new Map<string, VmDashboardPanel>();
	private readonly disposables: vscode.Disposable[] = [];

	static show(extensionUri: vscode.Uri, manager: ConnectionManager, ref: VmRef): void {
		const key = `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;
		const existing = VmDashboardPanel.panels.get(key);
		if (existing) {
			existing.panel.reveal();
			return;
		}
		const vm = manager.findVm(ref)?.vm;
		// Retained while hidden so the chart history survives tab switches; the host skips the
		// statistics work while the tab is not visible (see `getStats`).
		const panel = vscode.window.createWebviewPanel(
			VM_DASHBOARD_VIEW_TYPE,
			`${vm?.name ?? ref.vmId} — Details`,
			vscode.ViewColumn.Active,
			webviewOptions(extensionUri, true)
		);
		VmDashboardPanel.panels.set(key, new VmDashboardPanel(key, panel, extensionUri, manager, ref, vm?.name));
	}

	/**
	 * Opens (or reveals) the details page of the VM and asks for a disk size in a modal there. Resolves with the
	 * answer, or `undefined` when the user cancels or closes the page. A new question replaces an unanswered one.
	 */
	static askDiskSize(extensionUri: vscode.Uri, manager: ConnectionManager, ref: VmRef, question: Omit<DiskSizeRequest, 'askId'>): Promise<DiskSizeAnswer | undefined> {
		VmDashboardPanel.show(extensionUri, manager, ref);
		const panel = VmDashboardPanel.panels.get(`${ref.clusterId}/${ref.nodeId}/${ref.vmId}`);
		return panel ? panel.ask(question) : Promise.resolve(undefined);
	}

	private static nextAskId = 1;
	private pending: { request: DiskSizeRequest; resolve: (answer: DiskSizeAnswer | undefined) => void } | undefined;
	private channel: WebviewChannel | undefined;

	private ask(question: Omit<DiskSizeRequest, 'askId'>): Promise<DiskSizeAnswer | undefined> {
		this.answer(undefined);
		const request: DiskSizeRequest = { ...question, askId: VmDashboardPanel.nextAskId++ };
		return new Promise((resolve) => {
			this.pending = { request, resolve };
			// A page that is still loading asks for it once it is ready (`getDiskSizeAsk`).
			void this.channel?.post({ kind: 'event', name: 'diskSizeAsk', payload: request });
		});
	}

	private answer(answer: DiskSizeAnswer | undefined, askId?: number): void {
		const pending = this.pending;
		if (!pending || (askId !== undefined && askId !== pending.request.askId)) return;
		this.pending = undefined;
		pending.resolve(answer);
	}

	/** Closes the details tab of a VM that no longer exists. */
	static closeFor(ref: VmRef): void {
		VmDashboardPanel.panels.get(`${ref.clusterId}/${ref.nodeId}/${ref.vmId}`)?.dispose();
	}

	private constructor(
		private readonly key: string,
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		manager: ConnectionManager,
		ref: VmRef,
		vmName: string | undefined
	) {
		panel.iconPath = panelIcon(extensionUri, 'dashboard');
		panel.webview.html = renderHtml(panel.webview, extensionUri, { view: 'vmDashboard', title: panel.title, ref, vmName });
		const channel = new WebviewChannel(panel.webview, {
			// The VM is fixed by this panel; whatever `ref` the page sends is ignored.
			runCommand: async ({ command, diskId }) => {
				if (!ALLOWED_COMMANDS.has(command)) throw new Error(`Command not allowed: ${command}`);
				await vscode.commands.executeCommand(command, typeof diskId === 'string' ? { ...ref, diskId } : ref);
			},
			getDashboard: async () => {
				await manager.connect(ref.clusterId).catch(() => undefined);
				return { vm: manager.findVm(ref)?.vm, capabilities: manager.cluster(ref.clusterId)?.connection?.capabilities };
			},
			getDetails: async () => {
				const connection = await manager.connect(ref.clusterId);
				return connection.getVmDetails?.(ref.nodeId, ref.vmId);
			},
			getPassthrough: async () => {
				const connection = await manager.connect(ref.clusterId);
				return connection.getPassthrough?.(ref.nodeId, ref.vmId);
			},
			changePassthrough: async ({ deviceId, action }) => {
				const connection = await manager.connect(ref.clusterId);
				if (!connection.planPassthrough || !connection.changePassthrough) throw new Error('This hypervisor cannot pass devices through');
				const plan = await connection.planPassthrough(ref.nodeId, ref.vmId, deviceId, action);
				if (plan.needsConfirmation) {
					const detail = [
						plan.experimental ? 'EXPERIMENTAL: not validated on every host. A wrong choice can freeze the host or blank its display.' : undefined,
						plan.warnings.length ? `Warnings:\n${plan.warnings.map((w) => `• ${w}`).join('\n')}` : undefined,
						`This will:\n${plan.steps.map((s) => (s.startsWith(' ') ? s : `• ${s}`)).join('\n')}`
					]
						.filter(Boolean)
						.join('\n\n');
					const choice = await vscode.window.showWarningMessage(plan.title, { modal: true, detail }, action === 'attach' ? 'Attach' : 'Detach');
					if (!choice) return { changed: false };
				}
				await connection.changePassthrough(ref.nodeId, ref.vmId, deviceId, action, { confirmed: true });
				await manager.refresh(ref.clusterId);
				return { changed: true };
			},
			listSnapshots: async () => {
				const location = manager.findVm(ref);
				return location ? listSnapshots(manager, location) : [];
			},
			takeSnapshot: async ({ name }) => {
				const location = manager.findVm(ref);
				return location ? takeSnapshot(manager, location, name) : undefined;
			},
			revertSnapshot: async ({ snapshotId }) => {
				const location = manager.findVm(ref);
				const snapshot = location && (await listSnapshots(manager, location)).find((s) => s.id === snapshotId);
				return location && snapshot ? revertSnapshot(manager, location, snapshot) : false;
			},
			deleteSnapshot: async ({ snapshotId }) => {
				const location = manager.findVm(ref);
				const snapshot = location && (await listSnapshots(manager, location)).find((s) => s.id === snapshotId);
				return location && snapshot ? deleteSnapshot(manager, location, snapshot) : false;
			},
			addForward: async ({ forward }) => {
				const connection = await manager.connect(ref.clusterId);
				if (!connection.addPortForward) throw new Error('This hypervisor cannot forward ports');
				await connection.addPortForward(ref.nodeId, ref.vmId, forward);
				await manager.refresh(ref.clusterId);
			},
			removeForward: async ({ forward }) => {
				const connection = await manager.connect(ref.clusterId);
				if (!connection.removePortForward) throw new Error('This hypervisor cannot forward ports');
				await connection.removePortForward(ref.nodeId, ref.vmId, forward);
				await manager.refresh(ref.clusterId);
			},
			forwardAction: async ({ action, forward }) => {
				if (action === 'copySsh') {
					const command = sshCommand(forward);
					if (!command) throw new Error('Only TCP forwards to guest port 22 have an ssh command');
					await vscode.env.clipboard.writeText(command);
					void vscode.window.showInformationMessage(`Copied: ${command}`);
				} else {
					const url = browserUrl(forward);
					if (!url) throw new Error('This forward is not to a web port');
					await vscode.env.openExternal(vscode.Uri.parse(url));
				}
			},
			getDiskSizeAsk: async () => this.pending?.request,
			submitDiskSize: async (answer) => {
				const request = this.pending?.request;
				if (!request || request.askId !== answer.askId) throw new Error('This question was already answered.');
				// The page checks too; these are the checks that count.
				if ('file' in answer) {
					const path = typeof answer.file?.path === 'string' ? answer.file.path.trim() : '';
					const copy = answer.file?.copy !== false;
					if (!request.attach || !request.attach.modes.includes(copy ? 'copy' : 'reference')) throw new Error('An image file cannot be attached that way here.');
					if (!/^(\/|[A-Za-z]:[\\/])/.test(path)) throw new Error('Give the full path of the image.');
					this.answer({ file: { path, copy } }, answer.askId);
					return;
				}
				const { bytes, format } = answer;
				const problem = typeof bytes === 'number' ? bytesProblem(bytes, request.currentBytes) : 'Enter a size.';
				if (problem) throw new Error(problem);
				const chosen = request.mode === 'add' ? (format && request.formats?.includes(format) ? format : request.formats?.[0]) : undefined;
				this.answer({ bytes, ...(chosen ? { format: chosen } : {}) }, answer.askId);
			},
			browseDiskImage: async () => {
				const uris = await vscode.window.showOpenDialog({
					title: 'Disk image to attach',
					canSelectMany: false,
					openLabel: 'Select',
					filters: { 'Disk images': ['qcow2', 'img', 'raw', 'vmdk', 'vhdx', 'vhd', 'vdi', 'qcow'], 'All files': ['*'] }
				});
				return uris?.[0]?.fsPath;
			},
			cancelDiskSize: async ({ askId }) => this.answer(undefined, askId),
			getStats: async () => {
				if (!panel.visible) return undefined;
				const connection = await manager.connect(ref.clusterId);
				return connection.getVmStats?.(ref.nodeId, ref.vmId);
			}
		});
		this.channel = channel;
		this.disposables.push(
			channel,
			panel.onDidDispose(() => this.dispose()),
			manager.onDidChange((clusterId) => {
				if (clusterId !== ref.clusterId) return;
				const vm = manager.findVm(ref)?.vm;
				if (vm && panel.title !== `${vm.name} — Details`) panel.title = `${vm.name} — Details`;
				void channel.post({ kind: 'event', name: 'vm', payload: vm });
			})
		);
	}

	dispose(): void {
		this.answer(undefined);
		VmDashboardPanel.panels.delete(this.key);
		vscode.Disposable.from(...this.disposables).dispose();
		this.panel.dispose();
	}
}
