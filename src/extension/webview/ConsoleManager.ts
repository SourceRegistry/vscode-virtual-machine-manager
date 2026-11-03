import * as vscode from 'vscode';
import type { ConsoleStream, PowerAction } from '@vmm/sdk';
import type { ViewKind, VmRef, WebviewToHost } from '../../shared/protocol';
import type { ConnectionManager } from '../clusters/ConnectionManager';
import { errorMessage, log } from '../util/log';
import { panelIcon, renderHtml, toBuffer, WebviewChannel, webviewOptions } from './WebviewHost';

export type ConsoleViewKind = 'vnc' | 'serial' | 'preview';

const VIEW_TYPES: Record<ConsoleViewKind, string> = {
	vnc: 'vmm.console.vnc',
	serial: 'vmm.console.serial',
	preview: 'vmm.console.preview'
};

/**
 * A console editor tab. The webview never opens sockets itself: the provider returns a byte
 * stream on the extension host and this session relays it over postMessage. That keeps the CSP
 * strict and works unchanged in Remote-SSH / WSL / Codespaces.
 */
class ConsoleSession implements vscode.Disposable {
	private stream: ConsoleStream | undefined;
	private previewAbort: AbortController | undefined;
	private readonly channel: WebviewChannel;
	private readonly disposables: vscode.Disposable[] = [];
	private generation = 0;

	constructor(
		readonly key: string,
		readonly ref: VmRef,
		readonly kind: ConsoleViewKind,
		readonly panel: vscode.WebviewPanel,
		private readonly manager: ConnectionManager,
		private readonly onDispose: (session: ConsoleSession) => void
	) {
		this.channel = new WebviewChannel(
			panel.webview,
			{
				reconnect: () => this.connect(),
				power: ({ action }) => manager.power(ref, action),
				openExternal: async () => {
					const connection = await manager.connect(ref.clusterId);
					if (!connection.openExternal) throw new Error('This hypervisor has no native viewer');
					await connection.openExternal(ref.nodeId, ref.vmId);
				}
			},
			(message) => this.onMessage(message)
		);
		this.disposables.push(this.channel, panel.onDidDispose(() => this.dispose()));
	}

	private onMessage(message: WebviewToHost): void {
		switch (message.kind) {
			case 'ready':
				// (Re)load of the webview — e.g. after moving it into a new window. Start a fresh
				// connection so protocol handshakes (RFB) start from the beginning.
				void this.connect();
				break;
			case 'console.input':
				this.stream?.stream.write(toBuffer(message.data));
				break;
		}
	}

	async connect(): Promise<void> {
		const generation = ++this.generation;
		this.closeStream();
		await this.channel.post({ kind: 'console.status', status: 'connecting' });
		try {
			const connection = await this.manager.connect(this.ref.clusterId);
			if (this.kind === 'preview') {
				if (!connection.openPreview) throw new Error('Preview is not supported by this hypervisor');
				const abort = new AbortController();
				this.previewAbort = abort;
				void this.channel.post({ kind: 'console.status', status: 'open' });
				void (async () => {
					try {
						for await (const frame of connection.openPreview!(this.ref.nodeId, this.ref.vmId, abort.signal)) {
							if (abort.signal.aborted) break;
							await this.channel.post({ kind: 'preview.frame', frame });
						}
						if (!abort.signal.aborted) void this.channel.post({ kind: 'console.status', status: 'closed' });
					} catch (error) {
						if (!abort.signal.aborted) {
							void this.channel.post({ kind: 'console.status', status: 'error', message: errorMessage(error) });
						}
					}
				})();
				return;
			}
			const stream = await connection.openConsole(this.ref.nodeId, this.ref.vmId, this.kind);
			if (generation !== this.generation) {
				stream.dispose();
				return;
			}
			this.stream = stream;
			stream.stream.on('data', (chunk: Buffer) => {
				void this.channel.post({ kind: 'console.data', data: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) });
			});
			stream.stream.on('error', (error) => {
				log.warn(`Console stream error: ${errorMessage(error)}`);
				if (this.stream === stream) void this.channel.post({ kind: 'console.status', status: 'error', message: errorMessage(error) });
			});
			stream.stream.on('close', () => {
				if (this.stream === stream) {
					this.stream = undefined;
					void this.channel.post({ kind: 'console.status', status: 'closed' });
				}
			});
			await this.channel.post({ kind: 'console.status', status: 'open' });
		} catch (error) {
			if (generation === this.generation) {
				await this.channel.post({ kind: 'console.status', status: 'error', message: errorMessage(error) });
			}
		}
	}

	sendCommand(command: 'ctrlAltDel' | 'toggleScaling'): void {
		void this.channel.post({ kind: 'console.command', command });
	}

	power(action: PowerAction): Promise<void> {
		return this.manager.power(this.ref, action);
	}

	private closeStream(): void {
		this.previewAbort?.abort();
		this.previewAbort = undefined;
		const stream = this.stream;
		this.stream = undefined;
		if (stream) {
			try {
				stream.dispose();
			} catch (error) {
				log.warn(`Closing console failed: ${errorMessage(error)}`);
			}
		}
	}

	dispose(): void {
		this.generation++;
		this.closeStream();
		vscode.Disposable.from(...this.disposables).dispose();
		this.onDispose(this);
	}
}

export class ConsoleManager implements vscode.Disposable {
	private readonly sessions = new Map<string, ConsoleSession>();
	private lastActive: ConsoleSession | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly manager: ConnectionManager
	) {}

	async open(ref: VmRef, kind: ConsoleViewKind): Promise<void> {
		const key = `${kind}:${ref.clusterId}:${ref.nodeId}:${ref.vmId}`;
		const existing = this.sessions.get(key);
		if (existing) {
			existing.panel.reveal();
			return;
		}
		const vm = this.manager.findVm(ref)?.vm;
		const name = vm?.name ?? ref.vmId;
		const title = kind === 'serial' ? `${name} — Serial` : name;
		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPES[kind],
			title,
			vscode.ViewColumn.Active,
			// Live sockets: keep the page alive while the tab is in the background.
			webviewOptions(this.extensionUri, true)
		);
		panel.iconPath = panelIcon(this.extensionUri, kind === 'serial' ? 'terminal' : 'vm');
		const scaleViewport = vscode.workspace.getConfiguration('vmm.console').get<boolean>('scaleViewport', true);
		const view: ViewKind = `console.${kind}`;
		panel.webview.html = renderHtml(panel.webview, this.extensionUri, {
			view,
			title,
			ref,
			vmName: name,
			settings: { scaleViewport }
		});
		const session = new ConsoleSession(key, ref, kind, panel, this.manager, (s) => {
			this.sessions.delete(s.key);
			if (this.lastActive === s) this.lastActive = undefined;
		});
		panel.onDidChangeViewState((e) => {
			if (e.webviewPanel.active) this.lastActive = session;
		});
		this.sessions.set(key, session);
		this.lastActive = session;

		if (vscode.workspace.getConfiguration('vmm.console').get<boolean>('openInNewWindow', false)) {
			await this.moveToNewWindow(session);
		}
	}

	/** The console the editor toolbar command applies to. */
	active(): ConsoleSession | undefined {
		for (const session of this.sessions.values()) if (session.panel.active) return session;
		return this.lastActive;
	}

	async moveToNewWindow(session = this.active()): Promise<void> {
		if (!session) return;
		session.panel.reveal(undefined, false);
		await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
	}

	dispose(): void {
		for (const session of [...this.sessions.values()]) session.dispose();
	}
}
