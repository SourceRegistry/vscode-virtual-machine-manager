import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { BootData, HostToWebview, RpcMethod, RpcMethods, WebviewToHost } from '../../shared/protocol';
import { errorMessage, log } from '../util/log';

export type RpcHandlers = {
	[M in RpcMethod]?: (params: RpcMethods[M]['params']) => Promise<RpcMethods[M]['result']> | RpcMethods[M]['result'];
};

export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
}

export function webviewOptions(
	extensionUri: vscode.Uri,
	retainContextWhenHidden = false
): vscode.WebviewPanelOptions & vscode.WebviewOptions {
	return {
		enableScripts: true,
		enableFindWidget: false,
		retainContextWhenHidden,
		localResourceRoots: [webviewRoot(extensionUri)]
	};
}

export function panelIcon(extensionUri: vscode.Uri, name: 'vm' | 'dashboard' | 'terminal' | 'settings'): { light: vscode.Uri; dark: vscode.Uri } {
	return {
		light: vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${name}-light.svg`),
		dark: vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${name}-dark.svg`)
	};
}

/** Builds the page shell: strict CSP, nonce'd module script and embedded boot data. */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, boot: BootData): string {
	const nonce = randomBytes(16).toString('base64');
	const root = webviewRoot(extensionUri);
	const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.css'));
	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} data: blob:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}' ${webview.cspSource}`
	].join('; ');
	const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
	<title>${escapeHtml(boot.title)}</title>
</head>
<body data-view="${boot.view}">
	<div id="app"></div>
	<script id="vmm-boot" type="application/json">${bootJson}</script>
	<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/**
 * Typed request/response channel over postMessage. Unknown messages are handed to `onMessage`.
 */
export class WebviewChannel implements vscode.Disposable {
	private readonly subscription: vscode.Disposable;

	constructor(
		private readonly webview: vscode.Webview,
		private readonly handlers: RpcHandlers,
		private readonly onMessage?: (message: WebviewToHost) => void
	) {
		this.subscription = webview.onDidReceiveMessage((message: WebviewToHost) => void this.handle(message));
	}

	post(message: HostToWebview): Thenable<boolean> {
		return this.webview.postMessage(message);
	}

	private async handle(message: WebviewToHost): Promise<void> {
		if (message?.kind !== 'request') {
			this.onMessage?.(message);
			return;
		}
		const handler = this.handlers[message.method] as ((params: unknown) => unknown) | undefined;
		if (!handler) {
			await this.post({ kind: 'response', id: message.id, ok: false, error: `Unknown method ${message.method}` });
			return;
		}
		try {
			const result = await handler(message.params);
			await this.post({ kind: 'response', id: message.id, ok: true, result });
		} catch (error) {
			log.warn(`Webview request ${message.method} failed: ${errorMessage(error)}`);
			await this.post({ kind: 'response', id: message.id, ok: false, error: errorMessage(error) });
		}
	}

	dispose(): void {
		this.subscription.dispose();
	}
}

/** Accepts whatever shape a binary payload arrives in from the webview. */
export function toBuffer(data: unknown): Buffer {
	if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (Array.isArray(data)) return Buffer.from(data as number[]);
	if (data && typeof data === 'object') return Buffer.from(Object.values(data as Record<string, number>));
	return Buffer.alloc(0);
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
