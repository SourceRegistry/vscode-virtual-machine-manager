import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { CORE_EXTENSION_ID, VMM_API_VERSION, checkApiCompatibility, type VmManagerApi } from '@vmm/sdk';
import { ProxmoxProvider } from './ProxmoxProvider';
import { SessionStore } from './session';

/** One keychain entry holds every live session; it is deleted when VS Code closes. */
const SESSION_SECRET = 'vmm.proxmox.sessions';
let provider: ProxmoxProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const core = vscode.extensions.getExtension<VmManagerApi>(CORE_EXTENSION_ID);
	if (!core) throw new Error('VM Manager is not installed');
	const api = core.isActive ? core.exports : await core.activate();
	const compatibility = checkApiCompatibility('Proxmox provider', VMM_API_VERSION, api);
	if (!compatibility.ok) {
		void vscode.window.showErrorMessage(compatibility.message!);
		throw new Error(compatibility.message);
	}
	const store = new SessionStore({
		read: () => context.secrets.get(SESSION_SECRET),
		write: async (value) => { if (value === undefined) await context.secrets.delete(SESSION_SECRET); else await context.secrets.store(SESSION_SECRET, value); }
	}, vscode.env.sessionId, () => vscode.workspace.getConfiguration('vmm.proxmox').get<boolean>('rememberSession', false));
	// A crash or a killed window can leave sessions behind; drop those of earlier runs.
	await store.prune().catch(() => {});
	// Turning the setting off must not leave the saved sessions of earlier runs behind.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('vmm.proxmox.rememberSession')) void store.prune().catch(() => {}); }));
	provider = new ProxmoxProvider({
		store,
		browserLogin: api.browserLogin?.bind(api),
		providerIcon: `data:image/png;base64,${readFileSync(context.asAbsolutePath('media/icon.png')).toString('base64')}`,
		openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
		prompt: (options) => vscode.window.showInputBox({ title: options.title, prompt: options.prompt, password: options.password, placeHolder: options.placeholder, value: options.value, ignoreFocusOut: true })
	});
	context.subscriptions.push(api.registerProvider(provider) as vscode.Disposable);
}

/**
 * VS Code is closing (or reloading): forget every session, unless the user opted in to remembering them
 * (`vmm.proxmox.rememberSession`; the tickets then stay in the keychain until they expire or the user signs out). Proxmox has no logout call, so the ticket
 * itself only dies at its two hour expiry; what matters is that no copy of it stays on this machine.
 */
export async function deactivate(): Promise<void> {
	await provider?.endSessions().catch(() => {});
	provider = undefined;
}
