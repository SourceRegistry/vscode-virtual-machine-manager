import * as vscode from 'vscode';
import { CORE_EXTENSION_ID, VMM_API_VERSION, type VmManagerApi } from '@vmm/sdk';
import { ProxmoxProvider } from './ProxmoxProvider';
import { SessionStore } from './session';

/** One keychain entry holds every live session; it is deleted when VS Code closes. */
const SESSION_SECRET = 'vmm.proxmox.sessions';
let provider: ProxmoxProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const core = vscode.extensions.getExtension<VmManagerApi>(CORE_EXTENSION_ID);
	if (!core) throw new Error('VM Manager is not installed');
	const api = core.isActive ? core.exports : await core.activate();
	if (api.apiVersion !== VMM_API_VERSION) throw new Error('Update VM Manager and its Proxmox provider to compatible versions.');
	const store = new SessionStore({
		read: () => context.secrets.get(SESSION_SECRET),
		write: async (value) => { if (value === undefined) await context.secrets.delete(SESSION_SECRET); else await context.secrets.store(SESSION_SECRET, value); }
	});
	// A crash can leave sessions behind; drop the ones that can no longer work.
	await store.prune().catch(() => {});
	provider = new ProxmoxProvider({
		store,
		openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
		prompt: (options) => vscode.window.showInputBox({ title: options.title, prompt: options.prompt, password: options.password, placeHolder: options.placeholder, value: options.value, ignoreFocusOut: true })
	});
	context.subscriptions.push(api.registerProvider(provider) as vscode.Disposable);
}

/**
 * VS Code is closing (or reloading): forget every session. Proxmox has no logout call, so the ticket
 * itself only dies at its two hour expiry; what matters is that no copy of it stays on this machine.
 */
export async function deactivate(): Promise<void> {
	await provider?.endSessions().catch(() => {});
	provider = undefined;
}
