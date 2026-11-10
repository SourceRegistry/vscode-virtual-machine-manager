import * as vscode from 'vscode';
import { CORE_EXTENSION_ID, VMM_API_VERSION, checkApiCompatibility, type VmManagerApi } from '@vmm/sdk';
import { LibvirtProvider } from './LibvirtProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const core = vscode.extensions.getExtension<VmManagerApi>(CORE_EXTENSION_ID);
	if (!core) throw new Error('VM Manager is not installed');
	const api = core.isActive ? core.exports : await core.activate();
	const compatibility = checkApiCompatibility('libvirt provider', VMM_API_VERSION, api);
	if (!compatibility.ok) {
		void vscode.window.showErrorMessage(compatibility.message!);
		throw new Error(compatibility.message);
	}
	context.subscriptions.push(api.registerProvider(new LibvirtProvider()) as vscode.Disposable);
}

export function deactivate(): void {}
