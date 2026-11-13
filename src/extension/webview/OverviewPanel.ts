import * as vscode from 'vscode';
import type { PowerAction } from '@vmm/sdk';
import type { BulkOutcome, OverviewCommand } from '../../shared/protocol';
import type { ConnectionManager } from '../clusters/ConnectionManager';
import { panelIcon, renderHtml, WebviewChannel, webviewOptions } from './WebviewHost';

export const OVERVIEW_VIEW_TYPE = 'vmm.overview';

const ALLOWED_COMMANDS = new Set<OverviewCommand>([
	'vmm.start',
	'vmm.shutdown',
	'vmm.reboot',
	'vmm.stop',
	'vmm.connectGraphical',
	'vmm.connectSerial',
	'vmm.openExternal',
	'vmm.editVm',
	'vmm.openVmDashboard',
	'vmm.ejectMedia',
	'vmm.changeMedia',
	'vmm.convertToTemplate',
	'vmm.convertToVm',
	'vmm.createFromTemplate',
	'vmm.deleteVm',
	'vmm.detachVm',
	'vmm.createVm',
	'vmm.attachRunningVm',
	'vmm.importFromFolder',
	'vmm.addCluster',
	'vmm.editCluster',
	'vmm.reconnectCluster',
	'vmm.refresh'
]);

const POWER_COMMANDS: Partial<Record<PowerAction, OverviewCommand>> = {
	start: 'vmm.start',
	shutdown: 'vmm.shutdown',
	reboot: 'vmm.reboot',
	stop: 'vmm.stop'
};

/** Singleton dashboard tab. Restored after reload through a WebviewPanelSerializer. */
export class OverviewPanel implements vscode.Disposable {
	private static current: OverviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly channel: WebviewChannel;
	private pending: NodeJS.Timeout | undefined;

	static show(extensionUri: vscode.Uri, manager: ConnectionManager): void {
		if (OverviewPanel.current) {
			OverviewPanel.current.panel.reveal();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			OVERVIEW_VIEW_TYPE,
			'VM Overview',
			vscode.ViewColumn.Active,
			webviewOptions(extensionUri)
		);
		OverviewPanel.current = new OverviewPanel(panel, extensionUri, manager);
	}

	static registerSerializer(extensionUri: vscode.Uri, manager: ConnectionManager): vscode.Disposable {
		return vscode.window.registerWebviewPanelSerializer(OVERVIEW_VIEW_TYPE, {
			async deserializeWebviewPanel(panel) {
				panel.webview.options = webviewOptions(extensionUri);
				OverviewPanel.current?.dispose();
				OverviewPanel.current = new OverviewPanel(panel, extensionUri, manager);
			}
		});
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly manager: ConnectionManager
	) {
		panel.iconPath = panelIcon(extensionUri, 'dashboard');
		panel.webview.html = renderHtml(panel.webview, extensionUri, { view: 'overview', title: 'VM Overview' });
		this.channel = new WebviewChannel(panel.webview, {
			snapshot: async () => {
				await Promise.all(manager.clusters().map((c) => manager.ensureLoaded(c.cluster.id)));
				return manager.snapshot();
			},
			// Through the commands, with the first VM as the clicked one and all of them as the selection: the tree's
			// multi-select runs the same code (eligibility, one confirmation, failures reported together).
			bulkPower: async ({ action, refs }) => {
				const command = POWER_COMMANDS[action];
				if (!command || !refs.length) return { done: 0, skipped: refs.length };
				return (await vscode.commands.executeCommand<BulkOutcome | undefined>(command, refs[0], refs)) ?? { done: 0, skipped: refs.length };
			},
			bulkDelete: async ({ refs }) => {
				if (!refs.length) return { done: 0, skipped: 0 };
				return (await vscode.commands.executeCommand<BulkOutcome | undefined>('vmm.deleteVm', refs[0], refs)) ?? { done: 0, skipped: refs.length };
			},
			vmStats: async ({ refs }) => {
				if (!panel.visible) return [];
				const samples = await Promise.all(
					refs.slice(0, 64).map(async (ref) => {
						const connection = manager.cluster(ref.clusterId)?.connection;
						if (!connection?.getVmStats) return undefined;
						try {
							return { ref, stats: await connection.getVmStats(ref.nodeId, ref.vmId) };
						} catch {
							return undefined;
						}
					})
				);
				return samples.filter((s): s is NonNullable<typeof s> => !!s);
			},
			runCommand: async ({ command, ref, clusterId, nodeId }) => {
				if (!ALLOWED_COMMANDS.has(command)) throw new Error(`Command not allowed: ${command}`);
				const arg = ref ?? (nodeId && clusterId ? { kind: 'node', clusterId, nodeId } : clusterId ? { kind: 'cluster', clusterId } : undefined);
				await vscode.commands.executeCommand(command, arg);
			}
		});
		manager.setVisible('overview', panel.visible);
		this.disposables.push(
			this.channel,
			panel.onDidChangeViewState(() => manager.setVisible('overview', panel.visible)),
			panel.onDidDispose(() => this.dispose()),
			manager.onDidChange(() => this.schedulePush())
		);
	}

	private schedulePush(): void {
		if (this.pending) return;
		this.pending = setTimeout(() => {
			this.pending = undefined;
			void this.channel.post({ kind: 'event', name: 'snapshot', payload: this.manager.snapshot() });
		}, 150);
	}

	dispose(): void {
		if (OverviewPanel.current === this) OverviewPanel.current = undefined;
		if (this.pending) clearTimeout(this.pending);
		this.manager.setVisible('overview', false);
		vscode.Disposable.from(...this.disposables).dispose();
		this.panel.dispose();
	}
}
