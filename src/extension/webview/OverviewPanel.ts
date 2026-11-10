import * as vscode from 'vscode';
import { eligibleFor } from '../../shared/overview';
import type { OverviewCommand } from '../../shared/protocol';
import { errorMessage, log } from '../util/log';
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
			bulkPower: async ({ action, refs }) => {
				const targets = refs
					.map((ref) => manager.findVm(ref))
					.filter((l): l is NonNullable<typeof l> => !!l && eligibleFor(action, l.vm, l.cluster.connection?.capabilities.power));
				const skipped = refs.length - targets.length;
				if (!targets.length) return { started: 0, skipped };
				if (action === 'stop' && vscode.workspace.getConfiguration('vmm').get<boolean>('confirmPowerOff', true)) {
					const choice = await vscode.window.showWarningMessage(
						`Power off ${targets.length} virtual machine${targets.length === 1 ? '' : 's'}?`,
						{ modal: true, detail: `${targets.map((l) => l.vm.name).join(', ')}\n\nThis is like pulling the power plug. Unsaved data in the guests may be lost. Use Shut Down for a clean shutdown.` },
						'Power Off'
					);
					if (choice !== 'Power Off') return { started: 0, skipped: refs.length };
				}
				// Not awaited: a graceful shutdown can take minutes; the tree and this page show the progress.
				const verb = { start: 'start', shutdown: 'shut down', reboot: 'reboot', stop: 'power off', reset: 'reset' }[action];
				void Promise.allSettled(targets.map((l) => manager.power(l.ref, action))).then((results) => {
					const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [`${targets[i]!.vm.name}: ${errorMessage(r.reason)}`] : []));
					if (!failures.length) return;
					log.warn(`Could not ${verb} ${failures.length} of ${targets.length}: ${failures.join('; ')}`);
					void vscode.window.showWarningMessage(`Could not ${verb} ${failures.length} of ${targets.length} virtual machines`, { detail: failures.join('\n'), modal: true });
				});
				return { started: targets.length, skipped };
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
