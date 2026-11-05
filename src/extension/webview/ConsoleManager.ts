import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ConsoleStream, PowerAction, RdpTarget } from '@vmm/sdk';
import { RdpErrorKind, type ViewKind, type VmRef, type WebviewToHost } from '../../shared/protocol';
import { RdpGateway } from '../rdp/RdpGateway';
import { vmConnectPayload } from '../rdp/rdcleanpath';
import { splitUsername, type RdpCredentialStore } from '../rdp/credentials';
import type { ConnectionManager } from '../clusters/ConnectionManager';
import { errorMessage, log } from '../util/log';
import { panelIcon, renderHtml, toBuffer, WebviewChannel, webviewOptions, webviewRoot } from './WebviewHost';

export type ConsoleViewKind = 'vnc' | 'serial' | 'preview' | 'rdp';

const VIEW_TYPES: Record<ConsoleViewKind, string> = {
	vnc: 'vmm.console.vnc',
	serial: 'vmm.console.serial',
	preview: 'vmm.console.preview',
	rdp: 'vmm.console.rdp'
};

/**
 * A console editor tab. The webview never opens sockets itself: the provider returns a byte
 * stream on the extension host and this session relays it over postMessage. That keeps the CSP
 * strict and works unchanged in Remote-SSH / WSL / Codespaces.
 */
class ConsoleSession implements vscode.Disposable {
	private stream: ConsoleStream | undefined;
	private previewAbort: AbortController | undefined;
	/** RDP: the gateway for the client's current socket, and what it connects to. */
	private gateway: RdpGateway | undefined;
	private rdp: { target: RdpTarget; token: string; singleSignOn: boolean } | undefined;
	/** Single sign-on failed once in this tab: use the password prompt until the tab is reopened. */
	private singleSignOnFailed = false;
	private readonly channel: WebviewChannel;
	private readonly disposables: vscode.Disposable[] = [];
	private generation = 0;

	constructor(
		readonly key: string,
		readonly ref: VmRef,
		readonly kind: ConsoleViewKind,
		readonly panel: vscode.WebviewPanel,
		private readonly manager: ConnectionManager,
		private readonly credentials: RdpCredentialStore,
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
				if (this.gateway) this.gateway.write(toBuffer(message.data));
				else this.stream?.stream.write(toBuffer(message.data));
				break;
			case 'notify': {
				const text = `${this.manager.findVm(this.ref)?.vm.name ?? 'Console'}: ${String(message.message).slice(0, 500)}`;
				if (message.level === 'warn') void vscode.window.showWarningMessage(text);
				else void vscode.window.showInformationMessage(text);
				break;
			}
			case 'log': {
				const line = `[console ${this.manager.findVm(this.ref)?.vm.name ?? this.ref.vmId}] ${String(message.message).slice(0, 2000)}`;
				if (message.level === 'error') log.error(line);
				else if (message.level === 'warn') log.warn(line);
				else log.info(line);
				break;
			}
			case 'console.socket':
				if (message.action === 'open') this.openGateway();
				else this.closeGateway();
				break;
			case 'rdp.ended':
				this.closeGateway();
				if (message.errorKind === RdpErrorKind.WrongPassword || message.errorKind === RdpErrorKind.LogonFailure) {
					void this.signInRejected();
				}
				break;
		}
	}

	async connect(): Promise<void> {
		if (this.kind === 'rdp') return this.startRdp();
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
			if (stream.credentials) await this.channel.post({ kind: 'console.credentials', password: stream.credentials.password });
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

	/**
	 * RDP: resolve where to connect and with which account, then let the webview's IronRDP client
	 * start. The client opens its "WebSocket" (relayed to `openGateway`) right after.
	 */
	private async startRdp(options: { force?: boolean; reason?: string } = {}): Promise<void> {
		const generation = ++this.generation;
		this.closeStream();
		await this.channel.post({ kind: 'console.status', status: 'connecting' });
		try {
			const connection = await this.manager.connect(this.ref.clusterId);
			if (!connection.getRdpTarget) throw new Error('This hypervisor does not offer an RDP console.');
			const target = await connection.getRdpTarget(this.ref.nodeId, this.ref.vmId);
			const singleSignOn = !!target.currentUser && !!target.vmConnect && !this.singleSignOnFailed && !options.force;
			const credentials = singleSignOn
				? { ...splitUsername(target.currentUser!.displayName), password: '' }
				: await this.credentials.resolve(this.ref.clusterId, target, options);
			if (generation !== this.generation) return;
			if (!credentials) throw new Error('Sign-in was cancelled. Reconnect to try again.');
			const token = randomBytes(24).toString('base64url');
			this.rdp = { target, token, singleSignOn };
			if (singleSignOn) log.info(`RDP console: signing in as ${target.currentUser!.displayName} (Windows single sign-on)`);
			await this.channel.post({
				kind: 'rdp.start',
				config: {
					username: credentials.username,
					domain: credentials.domain,
					password: credentials.password,
					destination: `${target.serverName}:${target.vmConnect ? 2179 : 3389}`,
					authToken: token,
					vmConnect: target.vmConnect,
					singleSignOn
				}
			});
		} catch (error) {
			if (generation === this.generation) {
				await this.channel.post({ kind: 'console.status', status: 'error', message: errorMessage(error) });
			}
		}
	}

	/** Drops the rejected password (Reconnect asks again) and explains what to check. */
	private async signInRejected(): Promise<void> {
		await this.credentials.invalidate(this.ref.clusterId);
		const help = this.rdp?.target.signInHelp;
		log.warn('RDP console sign-in was rejected by the server');
		await this.channel.post({
			kind: 'console.status',
			status: 'error',
			message: `The user name or password was rejected. ${help ?? ''} Reconnect to sign in again.`.replace(/\s+/g, ' ').trim()
		});
	}

	private openGateway(): void {
		this.closeGateway();
		const rdp = this.rdp;
		if (!rdp) {
			void this.channel.post({ kind: 'console.status', status: 'error', message: 'The RDP session was not prepared. Reconnect to try again.' });
			return;
		}
		const { target, token, singleSignOn } = rdp;
		const gateway: RdpGateway = new RdpGateway({
			authToken: token,
			open: async () => {
				const connection = await this.manager.connect(this.ref.clusterId);
				const endpoint = await connection.openConsole(this.ref.nodeId, this.ref.vmId, 'rdp');
				return {
					stream: endpoint.stream,
					dispose: () => endpoint.dispose(),
					serverName: target.serverName,
					vmConnectPayload: target.vmConnect ? vmConnectPayload(target.vmConnect.vmId, target.vmConnect.mode) : undefined,
					createSecurityContext: singleSignOn && target.currentUser ? (name) => target.currentUser!.createContext(name) : undefined
				};
			},
			send: (data) => void this.channel.post({ kind: 'console.data', data }),
			close: (error, details) => {
				if (this.gateway !== gateway) return;
				this.gateway = undefined;
				if (details?.singleSignOnFailed) {
					this.singleSignOnFailed = true;
					log.warn(`RDP console: ${error}`);
					error = `${error}. Reconnect to sign in with a user name and password instead.`;
				}
				void this.channel.post({ kind: 'console.status', status: error ? 'error' : 'closed', message: error });
			},
			log: (line) => log.info(line)
		});
		this.gateway = gateway;
		void this.channel.post({ kind: 'console.status', status: 'open' });
	}

	private closeGateway(): void {
		const gateway = this.gateway;
		this.gateway = undefined;
		gateway?.dispose();
	}

	sendCommand(command: 'ctrlAltDel' | 'toggleScaling'): void {
		void this.channel.post({ kind: 'console.command', command });
	}

	/** Types `text` into the guest as key presses. Returns false when nothing is connected. */
	typeText(text: string): boolean {
		if (this.kind === 'serial') {
			// A serial line takes the characters themselves; terminals send CR for Enter.
			if (!this.stream) return false;
			this.stream.stream.write(Buffer.from(text.replace(/\r?\n/g, '\r'), 'utf8'));
			return true;
		}
		if (this.kind === 'preview') return false;
		void this.channel.post({ kind: 'console.type', text });
		return true;
	}

	power(action: PowerAction): Promise<void> {
		return this.manager.power(this.ref, action);
	}

	private closeStream(): void {
		this.closeGateway();
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
		private readonly manager: ConnectionManager,
		private readonly credentials: RdpCredentialStore
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
			settings: { scaleViewport },
			rdp:
				kind === 'rdp'
					? { wasmUrl: panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot(this.extensionUri), 'ironrdp_web_bg.wasm')).toString() }
					: undefined
		});
		const session = new ConsoleSession(key, ref, kind, panel, this.manager, this.credentials, (s) => {
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
