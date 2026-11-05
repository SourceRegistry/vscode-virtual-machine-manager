import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BrowserLoginService, renderLoginPage } from '../src/extension/auth/BrowserLogin';

const template = readFileSync('media/auth/callback.html', 'utf8');
const icon = 'data:image/png;base64,AA==';
const port = () => 24000 + Math.floor(Math.random() * 10000);

function fixture(onOpen: (redirect: string) => Promise<void>) {
	const host = { template, icon, editorUrl: 'vscode://', openUrl: vi.fn(onOpen) };
	return { service: new BrowserLoginService(host), host };
}

describe('shared browser login', () => {
	it('escapes template values and rejects missing variables', () => {
		expect(renderLoginPage('<h1>{{name}}</h1>', { name: '<img src=x onerror="bad">' })).toBe('<h1>&lt;img src=x onerror=&quot;bad&quot;&gt;</h1>');
		expect(() => renderLoginPage('{{missing}}', {})).toThrow('Missing login page variable');
	});
	it('exchanges the code before showing success and cleans up its listener', async () => {
		const callbackPort = port();
		let page: Promise<Response> | undefined;
		const { service } = fixture(async () => { page = fetch(`http://127.0.0.1:${callbackPort}/?code=private-code&state=private-state`); });
		const exchange = vi.fn(async () => ({ ticket: 'private-ticket' }));
		const providerIcon = 'data:image/png;base64,AQ==';
		try {
			expect(await service.login({ providerName: '<Proxmox>', providerIcon, port: callbackPort, getAuthorizationUrl: async (url) => `https://idp.test/?redirect=${encodeURIComponent(url)}`, exchange })).toEqual({ ticket: 'private-ticket' });
			const response = await page!;
			const html = await response.text();
			expect(html).toContain('You’re signed in');
			expect(html).toContain('&lt;Proxmox&gt;');
			expect(html).toContain(`<link rel="icon" type="image/png" href="${providerIcon}">`);
			expect(html).not.toContain('/favicon.ico');
			expect(html).toContain('data-auto-close="true"');
			expect(html).not.toMatch(/private-code|private-state|private-ticket|\{\{/);
			expect(response.headers.get('content-security-policy')).toContain("img-src data:");
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(exchange).toHaveBeenCalledWith({ code: 'private-code', state: 'private-state', redirectUrl: `http://localhost:${callbackPort}/` });
			await expect(fetch(`http://127.0.0.1:${callbackPort}/health`)).rejects.toThrow();
		} finally { service.dispose(); }
	});
	it('shows failure when the exchange fails instead of displaying success', async () => {
		const callbackPort = port();
		let page: Promise<Response> | undefined;
		const { service } = fixture(async () => { page = fetch(`http://127.0.0.1:${callbackPort}/?code=c&state=s`); });
		try {
			await expect(service.login({ providerName: 'Proxmox', port: callbackPort, getAuthorizationUrl: async () => 'https://idp.test/', exchange: async () => { throw new Error('private server detail'); } })).rejects.toThrow('private server detail');
			const html = await (await page!).text();
			expect(html).toContain('Sign-in wasn’t completed');
			expect(html).toContain('data-auto-close="false"');
			expect(html).not.toContain('private server detail');
		} finally { service.dispose(); }
	});
	it('releases the port if browser opening fails and cancels attempts on disposal', async () => {
		const callbackPort = port();
		const { service } = fixture(async () => { throw new Error('Browser unavailable'); });
		await expect(service.login({ providerName: 'Test', port: callbackPort, getAuthorizationUrl: async () => 'https://idp.test/', exchange: async () => 'session' })).rejects.toThrow('Browser unavailable');
		const retry = fixture(async () => { retry.service.dispose(); });
		await expect(retry.service.login({ providerName: 'Test', port: callbackPort, getAuthorizationUrl: async () => 'https://idp.test/', exchange: async () => 'session' })).rejects.toThrow('cancelled');
		service.dispose();
	});
});
