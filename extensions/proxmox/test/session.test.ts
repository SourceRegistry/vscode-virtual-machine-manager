import { describe, expect, it, vi } from 'vitest';
import { connectionOptions } from '../src/ProxmoxProvider';
import { openIdLogin, passwordLogin, qualifiedUser, SessionAuth, SessionStore, tfaResponse, type Session, type SessionUi } from '../src/session';

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const bodyOf = (init?: RequestInit) => Object.fromEntries(new URLSearchParams(String(init?.body)));
const ui = (answer?: string): SessionUi & { prompt: ReturnType<typeof vi.fn>; openUrl: ReturnType<typeof vi.fn> } => ({ prompt: vi.fn().mockResolvedValue(answer), openUrl: vi.fn().mockResolvedValue(undefined) });
const base = 'https://pve.test:8006';

describe('Proxmox session login', () => {
	it('qualifies user names and classifies two-factor input', () => {
		expect(qualifiedUser('root', undefined)).toBe('root@pam');
		expect(qualifiedUser('alice', 'ldap')).toBe('alice@ldap');
		expect(qualifiedUser('bob@pve', 'ldap')).toBe('bob@pve');
		expect(tfaResponse('123 456')).toBe('totp:123456');
		expect(tfaResponse('abcd-1234-efgh')).toBe('recovery:abcd-1234-efgh');
		expect(tfaResponse('recovery:x')).toBe('recovery:x');
	});

	it('logs in with a password and no second factor', async () => {
		const transport = vi.fn().mockResolvedValue(json({ ticket: 'PVE:alice@pve:T', CSRFPreventionToken: 'C', username: 'alice@pve' }));
		const prompts = ui();
		const session = await passwordLogin(transport, base, 'alice@pve', 'pw', prompts);
		expect(session).toMatchObject({ ticket: 'PVE:alice@pve:T', csrf: 'C', username: 'alice@pve' });
		expect(prompts.prompt).not.toHaveBeenCalled();
		expect(bodyOf(transport.mock.calls[0]![1])).toMatchObject({ username: 'alice@pve', password: 'pw' });
	});

	it('answers a TOTP challenge with the typed code', async () => {
		const transport = vi.fn()
			.mockResolvedValueOnce(json({ ticket: 'PVE:alice@pve:!tfa!{"totp":true}', username: 'alice@pve', NeedTFA: 1 }))
			.mockResolvedValueOnce(json({ ticket: 'PVE:alice@pve:REAL', CSRFPreventionToken: 'C2', username: 'alice@pve' }));
		const session = await passwordLogin(transport, base, 'alice@pve', 'pw', ui('654321'));
		expect(session.ticket).toBe('PVE:alice@pve:REAL');
		expect(bodyOf(transport.mock.calls[1]![1])).toMatchObject({ password: 'totp:654321', 'tfa-challenge': 'PVE:alice@pve:!tfa!{"totp":true}' });
	});

	it('stops when the user cancels the code prompt and maps rejection to a permission error', async () => {
		const challenge = vi.fn().mockResolvedValue(json({ ticket: 'PVE:u:!tfa!{}', username: 'u@pam', NeedTFA: 1 }));
		await expect(passwordLogin(challenge, base, 'u@pam', 'pw', ui(undefined))).rejects.toMatchObject({ code: 'permission' });
		const refused = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
		await expect(passwordLogin(refused, base, 'u@pam', 'bad', ui())).rejects.toMatchObject({ code: 'permission' });
	});
});

describe('Proxmox session auth', () => {
	const session: Session = { ticket: 'T1', csrf: 'C1', username: 'u@pam', issued: Date.now() };

	it('sends the cookie, and the CSRF token only on writes', async () => {
		const transport = vi.fn().mockResolvedValue(new Response('{}'));
		const auth = new SessionAuth(session, base, transport, () => {});
		await auth.fetch(`${base}/api2/json/nodes`, { method: 'GET', headers: { Authorization: 'x' } });
		await auth.fetch(`${base}/api2/json/nodes/pve/qemu`, { method: 'POST' });
		const [get, post] = transport.mock.calls.map((c) => new Headers((c[1] as RequestInit).headers));
		expect(get!.get('Cookie')).toBe('PVEAuthCookie=T1');
		expect(get!.get('Authorization')).toBeNull();
		expect(get!.get('CSRFPreventionToken')).toBeNull();
		expect(post!.get('CSRFPreventionToken')).toBe('C1');
	});

	it('renews on 401 once and retries with the new ticket', async () => {
		const seen: string[] = [];
		const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
			if (String(input).includes('/access/ticket')) return json({ ticket: 'T2', CSRFPreventionToken: 'C2', username: 'u@pam' });
			const cookie = new Headers(init?.headers).get('Cookie')!;
			seen.push(cookie);
			return new Response('{}', { status: cookie.endsWith('T2') ? 200 : 401 });
		}) as unknown as typeof fetch;
		const changed = vi.fn();
		const client: { auth?: unknown } = {};
		const auth = new SessionAuth(session, base, transport, changed);
		auth.bind(client);
		const response = await auth.fetch(`${base}/api2/json/nodes`);
		expect(response.status).toBe(200);
		expect(seen).toEqual(['PVEAuthCookie=T1', 'PVEAuthCookie=T2']);
		expect(changed).toHaveBeenCalledWith(expect.objectContaining({ ticket: 'T2' }));
		expect(client.auth).toEqual({ ticket: 'T2', csrf: 'C2' });
	});

	it('renews before the ticket gets old and replaces the client re-login', async () => {
		const old: Session = { ...session, issued: Date.now() - 90 * 60 * 1000 };
		const transport = vi.fn(async (input: unknown) => String(input).includes('/access/ticket') ? json({ ticket: 'T3', CSRFPreventionToken: 'C3', username: 'u@pam' }) : new Response('{}')) as unknown as typeof fetch;
		const client: { login?: () => Promise<unknown> } = {};
		const auth = new SessionAuth(old, base, transport, () => {});
		auth.bind(client);
		await auth.fetch(`${base}/api2/json/nodes`);
		expect(auth.session.ticket).toBe('T3');
		await expect(client.login!()).rejects.toMatchObject({ code: 'permission' });
	});
});

describe('Proxmox session store', () => {
	function vault() {
		let value: string | undefined;
		return { read: async () => value, write: vi.fn(async (next: string | undefined) => { value = next; }), peek: () => value };
	}
	const fresh: Session = { ticket: 'T', csrf: 'C', username: 'u@pam', issued: Date.now() };

	it('returns a stored session only for the same server and user', async () => {
		const v = vault();
		const store = new SessionStore(v);
		await store.set('c1', base, fresh);
		expect(await store.get('c1', base, 'U@pam')).toMatchObject({ ticket: 'T' });
		expect(await store.get('c1', 'https://other:8006', 'u@pam')).toBeUndefined();
		expect(await store.get('c1', base, 'x@pam')).toBeUndefined();
	});

	it('ignores expired sessions, prunes them and clears everything on close', async () => {
		const v = vault();
		const store = new SessionStore(v);
		await store.set('old', base, { ...fresh, issued: Date.now() - 3 * 60 * 60 * 1000 });
		await store.set('new', base, fresh);
		expect(await store.get('old', base, 'u@pam')).toBeUndefined();
		await store.prune();
		expect(Object.keys(JSON.parse(v.peek()!))).toEqual(['new']);
		await store.remove('new');
		expect(v.peek()).toBeUndefined();
		await store.set('a', base, fresh);
		await store.clear();
		expect(v.peek()).toBeUndefined();
	});

	it('never holds a password', async () => {
		const v = vault();
		await new SessionStore(v).set('c', base, fresh);
		expect(v.peek()).not.toMatch(/password/i);
	});
});

describe('Proxmox OpenID login', () => {
	it('opens the provider and finishes with the redirected code', async () => {
		const port = 18000 + Math.floor(Math.random() * 1000);
		const calls: Array<{ path: string; body: Record<string, string> }> = [];
		const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
			const path = new URL(String(input)).pathname.replace('/api2/json', '');
			calls.push({ path, body: bodyOf(init) });
			return path === '/access/openid/auth-url' ? json('https://idp.test/auth?x=1') : json({ ticket: 'PVE:u@oidc:T', CSRFPreventionToken: 'C', username: 'u@oidc' });
		}) as unknown as typeof fetch;
		const prompts = ui();
		prompts.openUrl.mockImplementation(async () => { void fetch(`http://localhost:${port}/?code=CODE&state=STATE`); });
		const session = await openIdLogin(transport, base, 'oidc', port, prompts, AbortSignal.timeout(10_000));
		expect(session.username).toBe('u@oidc');
		expect(prompts.openUrl).toHaveBeenCalledWith('https://idp.test/auth?x=1');
		expect(calls[0]!.body['redirect-url']).toBe(`http://localhost:${port}/`);
		expect(calls[1]).toMatchObject({ path: '/access/openid/login', body: { code: 'CODE', state: 'STATE', 'redirect-url': `http://localhost:${port}/` } });
	});

	it('rejects an identity provider error', async () => {
		const port = 19000 + Math.floor(Math.random() * 1000);
		const transport = vi.fn(async () => json('https://idp.test/auth')) as unknown as typeof fetch;
		const prompts = ui();
		prompts.openUrl.mockImplementation(async () => { void fetch(`http://localhost:${port}/?error=access_denied`); });
		await expect(openIdLogin(transport, base, 'oidc', port, prompts, AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: 'permission' });
	});
});

describe('Proxmox connection options by method', () => {
	const cluster = (config: Record<string, unknown>) => ({ id: 'c', name: 'C', providerId: 'proxmox', config: { endpoint: base, ...config } });
	it('defaults to the API token so existing clusters keep working', () => {
		expect(connectionOptions(cluster({ tokenId: 'u@pve!t' }), { tokenSecret: 's' })).toMatchObject({ method: 'token', apiToken: 'u@pve!t=s' });
	});
	it('accepts a session without a saved password', () => {
		expect(connectionOptions(cluster({ authMethod: 'password', username: 'root' }), {})).toMatchObject({ method: 'password', username: 'root@pam', password: undefined });
		expect(connectionOptions(cluster({ authMethod: 'password', username: 'a', realm: 'ldap' }), { password: 'p' })).toMatchObject({ username: 'a@ldap', password: 'p' });
		expect(() => connectionOptions(cluster({ authMethod: 'password' }), {})).toThrow();
	});
	it('validates the OpenID realm and port', () => {
		expect(connectionOptions(cluster({ authMethod: 'openid', realm: 'oidc' }), {})).toMatchObject({ method: 'openid', realm: 'oidc', port: 8189 });
		expect(() => connectionOptions(cluster({ authMethod: 'openid', realm: 'oidc', oidcPort: 80 }), {})).toThrow();
		expect(() => connectionOptions(cluster({ authMethod: 'openid' }), {})).toThrow();
		expect(() => connectionOptions(cluster({ authMethod: 'saml' }), {})).toThrow();
	});
});
