import * as vscode from 'vscode';
import type { OverviewCommand, VmRef } from '../../shared/protocol';
import type { ConnectionManager } from '../clusters/ConnectionManager';
import { panelIcon, renderHtml, WebviewChannel, webviewOptions } from './WebviewHost';

export const VM_DASHBOARD_VIEW_TYPE = 'vmm.vmDashboard';

/** Commands the page may run, always on its own VM. */
const ALLOWED_COMMANDS = new Set<OverviewCommand>([
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
			runCommand: async ({ command }) => {
				if (!ALLOWED_COMMANDS.has(command)) throw new Error(`Command not allowed: ${command}`);
				await vscode.commands.executeCommand(command, ref);
			},
			getDashboard: async () => {
				await manager.connect(ref.clusterId).catch(() => undefined);
				return { vm: manager.findVm(ref)?.vm, capabilities: manager.cluster(ref.clusterId)?.connection?.capabilities };
			},
			getDetails: async () => {
				const connection = await manager.connect(ref.clusterId);
				return connection.getVmDetails?.(ref.nodeId, ref.vmId);
			},
			getStats: async () => {
				if (!panel.visible) return undefined;
				const connection = await manager.connect(ref.clusterId);
				return connection.getVmStats?.(ref.nodeId, ref.vmId);
			}
		});
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
		VmDashboardPanel.panels.delete(this.key);
		vscode.Disposable.from(...this.disposables).dispose();
		this.panel.dispose();
	}
}
