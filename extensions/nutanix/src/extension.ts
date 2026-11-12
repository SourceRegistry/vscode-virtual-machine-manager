import * as vscode from 'vscode';
import { CORE_EXTENSION_ID, VMM_API_VERSION, checkApiCompatibility, type VmManagerApi } from '@vmm/sdk';
import { NutanixProvider } from './NutanixProvider';

let provider: NutanixProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const core = vscode.extensions.getExtension<VmManagerApi>(CORE_EXTENSION_ID);
	if (!core) throw new Error('VM Manager is not installed');
	const api = core.isActive ? core.exports : await core.activate();
	const compatibility = checkApiCompatibility('Nutanix provider', VMM_API_VERSION, api);
	if (!compatibility.ok) {
		void vscode.window.showErrorMessage(compatibility.message!);
		throw new Error(compatibility.message);
	}
	provider = new NutanixProvider({
		openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
		prompt: (options) => vscode.window.showInputBox({ title: options.title, prompt: options.prompt, password: options.password, placeHolder: options.placeholder, value: options.value, ignoreFocusOut: true })
	});
	context.subscriptions.push(api.registerProvider(provider) as vscode.Disposable);
}

/** Passwords typed at sign-in live in memory only; drop them explicitly as well. */
export function deactivate(): void {
	provider?.forgetPasswords();
	provider = undefined;
}
