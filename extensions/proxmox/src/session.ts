import type { PveSession } from 'pve-client';
import { ProviderError, type VmManagerApi } from '@vmm/sdk';

/** Proxmox tickets live two hours; renew well before that. */
export const TICKET_LIFETIME_MS = 2 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 60 * 60 * 1000;

/** pve-client's ticket session: `{ticket, csrf, username, issued}`. */
export type Session = PveSession;

/** Interaction the provider needs from the host; kept abstract so this module has no vscode dependency. */
export interface SessionUi {
	browserLogin?: VmManagerApi['browserLogin'];
	providerIcon?: string;
	/** Asks the user for a value. Resolves undefined when they cancel. */
	prompt(options: { title: string; prompt: string; password?: boolean; placeholder?: string; value?: string }): PromiseLike<string | undefined>;
	openUrl(url: string): PromiseLike<unknown>;
}

interface TicketReply {
	ticket?: string;
	CSRFPreventionToken?: string;
	username: string;
}

async function call<T>(fetchImpl: typeof fetch, baseUrl: string, path: string, body: Record<string, string>): Promise<T> {
	const response = await fetchImpl(`${baseUrl}/api2/json${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams(body).toString()
	});
	if (response.status === 401 || response.status === 403) throw new ProviderError('Proxmox rejected the sign-in. Check the user name, realm, password and authentication code.', 'permission');
	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		throw new ProviderError(`Proxmox sign-in failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
	}
	return ((await response.json()) as { data: T }).data;
}

function toSession(reply: TicketReply): Session {
	if (!reply.ticket || !reply.CSRFPreventionToken) throw new ProviderError('Proxmox did not return a session.', 'failed');
	return { ticket: reply.ticket, csrf: reply.CSRFPreventionToken, username: reply.username, issued: Date.now() };
}

/** `root` + realm `pam` -> `root@pam`; a name that already has a realm wins. */
export function qualifiedUser(username: string, realm: string | undefined): string {
	const name = username.trim();
	return name.includes('@') ? name : `${name}@${realm?.trim() || 'pam'}`;
}

export function sessionFresh(session: Session, now = Date.now()): boolean {
	return now - (session.issued ?? 0) < TICKET_LIFETIME_MS - 5 * 60 * 1000;
}

export function withParam(url: string, key: string, value: string): string {
	const parsed = new URL(url);
	parsed.searchParams.set(key, value);
	return parsed.toString();
}

/** Browser sign-in through a Proxmox OpenID realm. The identity provider must allow `http://localhost:<port>/` as a redirect. */
/** Time to finish the OpenID sign-in in the browser: identity providers with a second factor or a password manager take a while. */
export const OPENID_TIMEOUT_MS = 15 * 60 * 1000;

export async function openIdLogin(fetchImpl: typeof fetch, baseUrl: string, realm: string, port: number, ui: SessionUi, signal: AbortSignal, forceLogin = false): Promise<Session> {
	if (!ui.browserLogin) throw new ProviderError('Update VM Manager to use shared browser sign-in.', 'unavailable');
	return ui.browserLogin({
		providerName: 'Proxmox VE', providerIcon: ui.providerIcon, port, signal, timeoutMs: OPENID_TIMEOUT_MS,
		getAuthorizationUrl: async (redirectUrl) => {
			const authUrl = await call<string>(fetchImpl, baseUrl, '/access/openid/auth-url', { realm, 'redirect-url': redirectUrl });
			return forceLogin ? withParam(authUrl, 'prompt', 'login') : authUrl;
		},
		exchange: async ({ code, state, redirectUrl }) => toSession(await call<TicketReply>(fetchImpl, baseUrl, '/access/openid/login', { code, state, 'redirect-url': redirectUrl }))
	});
}

/** Where sessions are kept; the host backs it with the OS keychain. */
export interface SessionVault {
	read(): PromiseLike<string | undefined>;
	write(value: string | undefined): PromiseLike<void>;
}

interface StoredEntry extends Session { baseUrl: string; /** The VS Code launch that created it. */ launch?: string }

/** Persists live sessions (never passwords) so a reconnect or reload does not ask for the second factor again. */
export class SessionStore {
	/** `launch` identifies this VS Code run: a session left by another run (a crash, a killed window) is never reused. */
	/** `remember` (the opt-in setting): sessions of earlier VS Code runs are reused instead of dropped. */
	constructor(private readonly vault: SessionVault, private readonly launch?: string, private readonly remember: () => boolean = () => false) {}
	/** Whether sessions outlive VS Code; the extension then keeps them on close. */
	get remembers(): boolean { return this.remember(); }
	private mine(entry: StoredEntry): boolean { return this.remember() || !this.launch || entry.launch === this.launch; }
	private async all(): Promise<Record<string, StoredEntry>> {
		try { return JSON.parse((await this.vault.read()) ?? '{}') as Record<string, StoredEntry>; } catch { return {}; }
	}
	async get(clusterId: string, baseUrl: string, username?: string): Promise<Session | undefined> {
		const entry = (await this.all())[clusterId];
		if (!entry || entry.baseUrl !== baseUrl || (username && entry.username.toLowerCase() !== username.toLowerCase()) || !sessionFresh(entry) || !this.mine(entry)) return undefined;
		return { ticket: entry.ticket, csrf: entry.csrf, username: entry.username, issued: entry.issued };
	}
	async set(clusterId: string, baseUrl: string, session: Session): Promise<void> {
		const all = await this.all();
		all[clusterId] = { ...session, baseUrl, launch: this.launch };
		await this.vault.write(JSON.stringify(all));
	}
	async remove(clusterId: string): Promise<void> {
		const all = await this.all();
		if (!(clusterId in all)) return;
		delete all[clusterId];
		await this.vault.write(Object.keys(all).length ? JSON.stringify(all) : undefined);
	}
	/** Deletes everything stored. Used when VS Code closes. */
	async clear(): Promise<void> { await this.vault.write(undefined); }
	/** Drops sessions that can no longer work (left behind by a crash). */
	async prune(): Promise<void> {
		const all = await this.all();
		const kept = Object.fromEntries(Object.entries(all).filter(([, entry]) => sessionFresh(entry) && this.mine(entry)));
		if (Object.keys(kept).length !== Object.keys(all).length) await this.vault.write(Object.keys(kept).length ? JSON.stringify(kept) : undefined);
	}
}
