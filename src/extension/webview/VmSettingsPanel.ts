import * as vscode from 'vscode';
import { coerceValues, validateValues } from '@vmm/sdk';
import type { VmRef } from '../../shared/protocol';
import type { ConnectionManager } from '../clusters/ConnectionManager';
import { panelIcon, renderHtml, WebviewChannel, webviewOptions } from './WebviewHost';

export const VM_SETTINGS_VIEW_TYPE = 'vmm.vmSettings';

/** One settings editor tab per VM. */
export class VmSettingsPanel implements vscode.Disposable {
	private static readonly panels = new Map<string, VmSettingsPanel>();
	private readonly disposables: vscode.Disposable[] = [];

	static show(extensionUri: vscode.Uri, manager: ConnectionManager, ref: VmRef): void {
		const key = `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;
		const existing = VmSettingsPanel.panels.get(key);
		if (existing) {
			existing.panel.reveal();
			return;
		}
		const vm = manager.findVm(ref)?.vm;
		const title = `${vm?.name ?? ref.vmId} — Settings`;
		const panel = vscode.window.createWebviewPanel(VM_SETTINGS_VIEW_TYPE, title, vscode.ViewColumn.Active, webviewOptions(extensionUri));
		VmSettingsPanel.panels.set(key, new VmSettingsPanel(key, panel, extensionUri, manager, ref, vm?.name));
	}

	private constructor(
		private readonly key: string,
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		manager: ConnectionManager,
		ref: VmRef,
		vmName: string | undefined
	) {
		panel.iconPath = panelIcon(extensionUri, 'settings');
		panel.webview.html = renderHtml(panel.webview, extensionUri, {
			view: 'vmSettings',
			title: panel.title,
			ref,
			vmName
		});
		const channel = new WebviewChannel(panel.webview, {
			getConfig: async () => {
				const connection = await manager.connect(ref.clusterId);
				const config = await connection.getVmConfig(ref.nodeId, ref.vmId);
				return { ...config, vm: manager.findVm(ref)?.vm };
			},
			save: async ({ values }) => {
				const connection = await manager.connect(ref.clusterId);
				const { schema } = await connection.getVmConfig(ref.nodeId, ref.vmId);
				const editable = schema.filter((f) => !f.readonly);
				const coerced = coerceValues(editable, values);
				const invalid = validateValues(editable, coerced);
				if (invalid) throw new Error(invalid.message);
				await connection.updateVm(ref.nodeId, ref.vmId, coerced);
				await manager.refresh(ref.clusterId);
				const name = manager.findVm(ref)?.vm.name;
				if (name) panel.title = `${name} — Settings`;
				return { message: 'Settings saved' };
			},
			ejectMedia: async ({ deviceId }) => {
				const connection = await manager.connect(ref.clusterId);
				if (!connection.ejectMedia) throw new Error('This hypervisor cannot eject media');
				await connection.ejectMedia(ref.nodeId, ref.vmId, deviceId);
				await manager.refresh(ref.clusterId);
			},
			browse: async ({ directory, title, current, filters }) => {
				const uris = await vscode.window.showOpenDialog({
					canSelectFiles: !directory,
					canSelectFolders: directory,
					canSelectMany: false,
					title,
					filters,
					defaultUri: current ? vscode.Uri.file(current) : undefined
				});
				return uris?.[0]?.fsPath;
			}
		});
		this.disposables.push(
			channel,
			panel.onDidDispose(() => this.dispose()),
			manager.onDidChange((clusterId) => {
				if (clusterId === ref.clusterId) void channel.post({ kind: 'event', name: 'vm', payload: manager.findVm(ref)?.vm });
			})
		);
	}

	dispose(): void {
		VmSettingsPanel.panels.delete(this.key);
		vscode.Disposable.from(...this.disposables).dispose();
		this.panel.dispose();
	}
}
