import { describe, expect, it, vi } from 'vitest';
import { connectionOptions } from '../src/ProxmoxProvider';
import { openIdLogin, qualifiedUser, SessionStore, withParam, type Session, type SessionUi } from '../src/session';

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const bodyOf = (init?: RequestInit) => Object.fromEntries(new URLSearchParams(String(init?.body)));
const ui = (answer?: string): SessionUi & { prompt: ReturnType<typeof vi.fn>; openUrl: ReturnType<typeof vi.fn> } => ({ prompt: vi.fn().mockResolvedValue(answer), openUrl: vi.fn().mockResolvedValue(undefined) });
const base = 'https://pve.test:8006';

describe('Proxmox session login', () => {
	it('qualifies user names', () => {
		expect(qualifiedUser('root', undefined)).toBe('root@pam');
		expect(qualifiedUser('alice', 'ldap')).toBe('alice@ldap');
		expect(qualifiedUser('bob@pve', 'ldap')).toBe('bob@pve');
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

	it('forces a fresh login at the identity provider after a sign-out', async () => {
		const port = 20000 + Math.floor(Math.random() * 1000);
		const transport = vi.fn(async (input: unknown) => String(input).includes('auth-url') ? json('https://idp.test/auth?client_id=x') : json({ ticket: 'T', CSRFPreventionToken: 'C', username: 'u@oidc' })) as unknown as typeof fetch;
		const prompts = ui();
		prompts.openUrl.mockImplementation(async () => { void fetch(`http://localhost:${port}/?code=C&state=S`); });
		await openIdLogin(transport, base, 'oidc', port, prompts, AbortSignal.timeout(10_000), true);
		expect(prompts.openUrl).toHaveBeenCalledWith('https://idp.test/auth?client_id=x&prompt=login');
		expect(withParam('https://a.test/x?prompt=none', 'prompt', 'login')).toBe('https://a.test/x?prompt=login');
	});

	it('can be cancelled while waiting, and the port is free to start again', async () => {
		const port = 21000 + Math.floor(Math.random() * 1000);
		const transport = vi.fn(async () => json('https://idp.test/auth')) as unknown as typeof fetch;
		const controller = new AbortController();
		const prompts = ui();
		prompts.openUrl.mockImplementation(async () => { setTimeout(() => controller.abort(), 20); });
		await expect(openIdLogin(transport, base, 'oidc', port, prompts, controller.signal)).rejects.toMatchObject({ code: 'permission' });
		// A second attempt on the same port must not hit "address in use".
		const retry = ui();
		retry.openUrl.mockImplementation(async () => { void fetch(`http://localhost:${port}/?code=C&state=S`); });
		const again = vi.fn(async (input: unknown) => String(input).includes('auth-url') ? json('https://idp.test/auth') : json({ ticket: 'T', CSRFPreventionToken: 'C', username: 'u@oidc' })) as unknown as typeof fetch;
		await expect(openIdLogin(again, base, 'oidc', port, retry, AbortSignal.timeout(10_000))).resolves.toMatchObject({ username: 'u@oidc' });
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
