import * as vscode from 'vscode';
import { CORE_EXTENSION_ID, VMM_API_VERSION, type VmManagerApi } from '@vmm/sdk';
import { ProxmoxProvider } from './ProxmoxProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const core = vscode.extensions.getExtension<VmManagerApi>(CORE_EXTENSION_ID);
	if (!core) throw new Error('VM Manager is not installed');
	const api = core.isActive ? core.exports : await core.activate();
	if (api.apiVersion !== VMM_API_VERSION) throw new Error('Update VM Manager and its Proxmox provider to compatible versions.');
	context.subscriptions.push(api.registerProvider(new ProxmoxProvider((url) => vscode.env.openExternal(vscode.Uri.parse(url)))) as vscode.Disposable);
}
