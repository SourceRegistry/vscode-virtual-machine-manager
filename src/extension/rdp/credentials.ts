import * as vscode from 'vscode';
import type { RdpTarget } from '@vmm/sdk';
import { CONSOLE_CREDENTIALS_KEY, secretStorageKey } from '../clusters/secrets';

export interface RdpCredentials {
	username: string;
	domain: string;
	password: string;
}

/**
 * `DOMAIN\user` → `{ domain, username }`; `user@domain` (UPN, Microsoft accounts) and plain
 * names are kept as the user name with an empty domain.
 */
export function splitUsername(input: string): { username: string; domain: string } {
	const value = input.trim();
	const slash = value.indexOf('\\');
	if (slash > 0) return { domain: value.slice(0, slash), username: value.slice(slash + 1) };
	return { domain: '', username: value };
}

export function joinUsername(credentials: Pick<RdpCredentials, 'username' | 'domain'>): string {
	return credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username;
}

/**
 * RDP console sign-in, stored per cluster in SecretStorage (OS keychain). The password is only
 * handed to the console webview of that cluster, which needs it for CredSSP.
 */
export class RdpCredentialStore {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	async get(clusterId: string): Promise<RdpCredentials | undefined> {
		const raw = await this.secrets.get(secretStorageKey(clusterId, CONSOLE_CREDENTIALS_KEY));
		if (!raw) return undefined;
		try {
			const parsed = JSON.parse(raw) as Partial<RdpCredentials>;
			if (typeof parsed.username === 'string' && typeof parsed.password === 'string') {
				return { username: parsed.username, domain: parsed.domain ?? '', password: parsed.password };
			}
		} catch {
			// Corrupt entry: ask again.
		}
		return undefined;
	}

	async forget(clusterId: string): Promise<void> {
		await this.secrets.delete(secretStorageKey(clusterId, CONSOLE_CREDENTIALS_KEY));
	}

	/** The server rejected the sign-in: drop the password, keep the user name for the next prompt. */
	async invalidate(clusterId: string): Promise<void> {
		const stored = await this.get(clusterId);
		if (!stored) return;
		await this.secrets.store(secretStorageKey(clusterId, CONSOLE_CREDENTIALS_KEY), JSON.stringify({ ...stored, password: '' }));
	}

	/** Stored credentials, or a prompt (which stores them) when none are stored or `force` is set. */
	async resolve(clusterId: string, target: RdpTarget, options: { force?: boolean; reason?: string } = {}): Promise<RdpCredentials | undefined> {
		const stored = await this.get(clusterId);
		if (stored?.password && !options.force) return stored;

		const hint = target.credentialsHint ?? `an account that may connect to ${target.serverName}`;
		const user = await vscode.window.showInputBox({
			title: 'Console Sign-in (1/2)',
			prompt: options.reason ? `${options.reason} Enter the user name for ${hint}.` : `User name for ${hint}`,
			placeHolder: 'DOMAIN\\user or user@example.com',
			value: stored ? joinUsername(stored) : target.defaultUsername,
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim() ? undefined : 'Enter a user name')
		});
		if (user === undefined) return undefined;
		const password = await vscode.window.showInputBox({
			title: 'Console Sign-in (2/2)',
			prompt: `Password for ${user.trim()}. It is stored in your operating system's keychain.`,
			password: true,
			ignoreFocusOut: true
		});
		if (password === undefined) return undefined;
		const credentials: RdpCredentials = { ...splitUsername(user), password };
		await this.secrets.store(secretStorageKey(clusterId, CONSOLE_CREDENTIALS_KEY), JSON.stringify(credentials));
		return credentials;
	}
}
