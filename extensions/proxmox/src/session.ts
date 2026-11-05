import { createServer } from 'node:http';
import { ProviderError } from '@vmm/sdk';

/** Proxmox tickets live two hours; renew well before that. */
export const TICKET_LIFETIME_MS = 2 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 60 * 60 * 1000;

export interface Session {
	ticket: string;
	csrf: string;
	/** `user@realm`, as Proxmox reports it. */
	username: string;
	/** Epoch ms of the login or last renewal. */
	issued: number;
}

/** Interaction the provider needs from the host; kept abstract so this module has no vscode dependency. */
export interface SessionUi {
	/** Asks the user for a value. Resolves undefined when they cancel. */
	prompt(options: { title: string; prompt: string; password?: boolean; placeholder?: string }): PromiseLike<string | undefined>;
	openUrl(url: string): PromiseLike<unknown>;
}

interface TicketReply {
	ticket?: string;
	CSRFPreventionToken?: string;
	username: string;
	NeedTFA?: number;
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

/** Turns what the user typed into the Proxmox second factor: 6-8 digits is TOTP, anything else a recovery key. */
export function tfaResponse(code: string): string {
	const value = code.trim().replace(/\s+/g, '');
	if (/^(totp|recovery|yubico|webauthn):/.test(value)) return value;
	return /^\d{6,8}$/.test(value) ? `totp:${value}` : `recovery:${value}`;
}

/** Username + password login, with the second step when the realm or user requires two-factor. */
export async function passwordLogin(fetchImpl: typeof fetch, baseUrl: string, username: string, password: string, ui: SessionUi): Promise<Session> {
	const first = await call<TicketReply>(fetchImpl, baseUrl, '/access/ticket', { username, password, 'new-format': '1' });
	const challenge = first.ticket ?? '';
	if (!first.NeedTFA && !challenge.includes('!tfa!')) return toSession(first);
	const code = await ui.prompt({ title: `Proxmox sign-in for ${username}`, prompt: 'Two-factor code (authenticator app, or a recovery key)', placeholder: '123456' });
	if (!code) throw new ProviderError('Sign-in cancelled.', 'permission');
	const second = await call<TicketReply>(fetchImpl, baseUrl, '/access/ticket', { username, password: tfaResponse(code), 'tfa-challenge': challenge, 'new-format': '1' });
	return toSession(second);
}

/** Ticket renewal: Proxmox accepts the still-valid ticket as the password. */
export async function renewTicket(fetchImpl: typeof fetch, baseUrl: string, session: Session): Promise<Session> {
	return toSession(await call<TicketReply>(fetchImpl, baseUrl, '/access/ticket', { username: session.username, password: session.ticket, 'new-format': '1' }));
}

export function sessionFresh(session: Session, now = Date.now()): boolean {
	return now - session.issued < TICKET_LIFETIME_MS - 5 * 60 * 1000;
}

/** Waits for the identity provider's redirect on a loopback port and resolves with its `code` and `state`. */
export function receiveOpenIdRedirect(port: number, signal: AbortSignal, timeoutMs = 5 * 60 * 1000): { redirectUrl: string; result: Promise<{ code: string; state: string }> } {
	const redirectUrl = `http://localhost:${port}/`;
	const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', redirectUrl);
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');
			const error = url.searchParams.get('error');
			if (!code && !state && !error) { res.writeHead(404).end(); return; }
			res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end(code && state ? 'Signed in. You can close this tab and return to VS Code.' : 'Sign-in failed. Return to VS Code.');
			done(code && state ? undefined : new ProviderError(`The identity provider refused the sign-in${error ? ` (${error})` : ''}.`, 'permission'), code && state ? { code, state } : undefined);
		});
		const timer = setTimeout(() => done(new ProviderError('OpenID sign-in timed out.', 'timeout')), timeoutMs);
		const abort = () => done(new ProviderError('OpenID sign-in cancelled.', 'permission'));
		let finished = false;
		function done(error?: Error, value?: { code: string; state: string }) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			server.close();
			server.closeAllConnections();
			error ? reject(error) : resolve(value!);
		}
		signal.addEventListener('abort', abort);
		server.once('error', (e: NodeJS.ErrnoException) => done(new ProviderError(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Choose another OpenID callback port.` : `OpenID callback failed: ${e.message}`, 'unavailable')));
		server.listen(port, '127.0.0.1');
	});
	return { redirectUrl, result };
}

/** Browser sign-in through a Proxmox OpenID realm. The identity provider must allow `http://localhost:<port>/` as a redirect. */
export async function openIdLogin(fetchImpl: typeof fetch, baseUrl: string, realm: string, port: number, ui: SessionUi, signal: AbortSignal): Promise<Session> {
	const { redirectUrl, result } = receiveOpenIdRedirect(port, signal);
	result.catch(() => {});
	// Listening starts synchronously with the call above; the auth URL names the redirect we listen on.
	const authUrl = await call<string>(fetchImpl, baseUrl, '/access/openid/auth-url', { realm, 'redirect-url': redirectUrl });
	if (!/^https?:\/\//.test(authUrl)) throw new ProviderError('Proxmox returned an invalid OpenID address.', 'failed');
	await ui.openUrl(authUrl);
	const { code, state } = await result;
	return toSession(await call<TicketReply>(fetchImpl, baseUrl, '/access/openid/login', { code, state, 'redirect-url': redirectUrl }));
}

/** Where sessions are kept; the host backs it with the OS keychain. */
export interface SessionVault {
	read(): PromiseLike<string | undefined>;
	write(value: string | undefined): PromiseLike<void>;
}

interface StoredEntry extends Session { baseUrl: string }

/** Persists live sessions (never passwords) so a reconnect or reload does not ask for the second factor again. */
export class SessionStore {
	constructor(private readonly vault: SessionVault) {}
	private async all(): Promise<Record<string, StoredEntry>> {
		try { return JSON.parse((await this.vault.read()) ?? '{}') as Record<string, StoredEntry>; } catch { return {}; }
	}
	async get(clusterId: string, baseUrl: string, username: string): Promise<Session | undefined> {
		const entry = (await this.all())[clusterId];
		if (!entry || entry.baseUrl !== baseUrl || entry.username.toLowerCase() !== username.toLowerCase() || !sessionFresh(entry)) return undefined;
		return { ticket: entry.ticket, csrf: entry.csrf, username: entry.username, issued: entry.issued };
	}
	async set(clusterId: string, baseUrl: string, session: Session): Promise<void> {
		const all = await this.all();
		all[clusterId] = { ...session, baseUrl };
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
		const kept = Object.fromEntries(Object.entries(all).filter(([, entry]) => sessionFresh(entry)));
		if (Object.keys(kept).length !== Object.keys(all).length) await this.vault.write(Object.keys(kept).length ? JSON.stringify(kept) : undefined);
	}
}

/** A live session: injects the cookie and CSRF token, renews before expiry and retries once on 401. */
export class SessionAuth {
	private renewing?: Promise<Session>;
	constructor(
		private current: Session,
		private readonly baseUrl: string,
		private readonly transport: typeof fetch,
		private readonly onChange: (session: Session) => void
	) {}
	get session(): Session { return this.current; }
	private client?: { auth?: { ticket?: string; csrf?: string }; login?: () => Promise<unknown> };
	/**
	 * pve-client has no way to start from an existing ticket, so hand it ours: its `sessionCookie()` (used
	 * by the display helper) then works, and its own password re-login (which could not answer a
	 * two-factor prompt) is replaced by an explanation.
	 */
	bind(client: object): void {
		this.client = client as typeof this.client;
		this.publish();
		this.client!.login = async () => { throw new ProviderError('The Proxmox session has expired. Reconnect the cluster to sign in again.', 'permission'); };
	}
	private publish(): void { if (this.client) this.client.auth = { ticket: this.current.ticket, csrf: this.current.csrf }; }
	private renew(): Promise<Session> {
		this.renewing ??= renewTicket(this.transport, this.baseUrl, this.current)
			.then((next) => { this.current = next; this.publish(); this.onChange(next); return next; })
			.finally(() => { this.renewing = undefined; });
		return this.renewing;
	}
	private send(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Promise<Response> {
		const headers = new Headers(init?.headers);
		headers.delete('Authorization');
		headers.set('Cookie', `PVEAuthCookie=${this.current.ticket}`);
		if ((init?.method ?? 'GET').toUpperCase() !== 'GET') headers.set('CSRFPreventionToken', this.current.csrf);
		return this.transport(input, { ...init, headers });
	}
	/** Wraps the transport the Proxmox client uses. */
	readonly fetch: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes('/access/ticket') || url.includes('/access/openid')) return this.transport(input, init);
		if (Date.now() - this.current.issued > RENEW_AFTER_MS) await this.renew().catch(() => {});
		const response = await this.send(input, init);
		if (response.status !== 401) return response;
		try { await this.renew(); } catch { return response; }
		return this.send(input, init);
	};
}
