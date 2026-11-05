import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { ProviderError, type BrowserLoginOptions } from '@vmm/sdk';

export interface BrowserLoginHost {
	template: string;
	icon: string;
	editorUrl: string;
	openUrl(url: string): PromiseLike<unknown>;
}

export function renderLoginPage(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
		if (!(key in values)) throw new Error(`Missing login page variable: ${key}`);
		return values[key]!.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
	});
}

/** Each login owns its listener. Disposing the service cancels every active attempt. */
export class BrowserLoginService {
	private readonly pending = new Set<AbortController>();
	private disposed = false;
	constructor(private readonly host: BrowserLoginHost) {}

	async login<T>(options: BrowserLoginOptions<T>): Promise<T> {
		if (this.disposed) throw new ProviderError('Browser sign-in is unavailable.', 'unavailable');
		if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new ProviderError('Invalid browser callback port.', 'invalid');
		const controller = new AbortController();
		this.pending.add(controller);
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000), ...(options.signal ? [options.signal] : [])]);
		const redirectUrl = `http://localhost:${options.port}/`;
		try {
			return await new Promise<T>((resolve, reject) => {
				let settled = false;
				let processing = false;
				const server = createServer(async (req, res) => {
					const url = new URL(req.url ?? '/', redirectUrl);
					if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(204, { 'Cache-Control': 'no-store' }).end(); return; }
					if (req.method !== 'GET' || url.pathname !== '/' || processing || settled) { res.writeHead(404).end(); return; }
					const code = url.searchParams.get('code');
					const state = url.searchParams.get('state');
					const error = url.searchParams.get('error');
					if (!code && !state && !error) { res.writeHead(404).end(); return; }
					processing = true;
					let value: T | undefined;
					let failure: unknown;
					try {
						if (!code || !state || error) throw new ProviderError('The identity provider refused the sign-in.', 'permission');
						value = await options.exchange({ code, state, redirectUrl });
					} catch (e) { failure = e; }
					if (settled) return;
					const success = failure === undefined;
					const nonce = randomBytes(18).toString('base64');
					const providerIcon = options.providerIcon && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(options.providerIcon) ? options.providerIcon : this.host.icon;
					const page = renderLoginPage(this.host.template, {
						title: success ? 'You’re signed in' : 'Sign-in wasn’t completed',
						description: success ? 'Your connection is ready. Return to VS Code to manage your cluster.' : 'Return to VS Code to review the error and start a new sign-in.',
						note: success ? 'This tab will close automatically if your browser allows it. Otherwise, you can close it now.' : 'You can close this tab and try again from VM Manager.',
						statusPath: success ? 'm8 12 3 3 5-6' : 'm9 9 6 6m0-6-6 6',
						providerName: options.providerName, providerIcon, favicon: providerIcon,
						editorUrl: this.host.editorUrl, nonce, autoClose: String(success)
					});
					res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
					res.once('finish', () => finish(failure, value));
					res.end(page);
				});
				function finish(error?: unknown, value?: T) {
					if (settled) return;
					settled = true;
					signal.removeEventListener('abort', abort);
					server.close();
					server.closeAllConnections();
					error === undefined ? resolve(value as T) : reject(error);
				}
				const abort = () => finish(new ProviderError(signal.reason?.name === 'TimeoutError' ? 'Browser sign-in timed out.' : 'Browser sign-in cancelled.', signal.reason?.name === 'TimeoutError' ? 'timeout' : 'permission'));
				signal.addEventListener('abort', abort, { once: true });
				server.once('error', (e: NodeJS.ErrnoException) => finish(new ProviderError(e.code === 'EADDRINUSE' ? `Port ${options.port} is in use. Choose another callback port.` : `Browser callback failed: ${e.message}`, 'unavailable')));
				if (signal.aborted) { abort(); return; }
				server.listen(options.port, '127.0.0.1', () => {
					void (async () => {
						const url = await options.getAuthorizationUrl(redirectUrl);
						signal.throwIfAborted();
						if (!/^https?:\/\//.test(url)) throw new ProviderError('Invalid browser authorization URL.', 'invalid');
						if (await this.host.openUrl(url) === false) throw new ProviderError('Could not open the sign-in browser.', 'unavailable');
					})().catch((e) => finish(e));
				});
			});
		} finally { this.pending.delete(controller); }
	}
	dispose(): void { this.disposed = true; for (const controller of this.pending) controller.abort(); this.pending.clear(); }
}
