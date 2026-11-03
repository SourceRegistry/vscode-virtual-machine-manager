import type { HostToWebview } from '../../../shared/protocol';
import { onMessage, post } from '../rpc/bridge';

/**
 * A `WebSocket` look-alike that tunnels over postMessage to the extension host's RDP gateway.
 *
 * IronRDP's WebAssembly client calls `new WebSocket(proxyAddress)`; installing this class as the
 * page's `WebSocket` routes that connection to the host instead of the network, so webviews never
 * open sockets and the console also works over Remote-SSH / WSL. Implements exactly what the
 * wasm-bindgen glue uses: add/removeEventListener, readyState, binaryType, send, close, and
 * open / message (ArrayBuffer) / close / error events.
 */
export class RelayWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;

	/** Only one relayed socket exists per console; a new one replaces the previous. */
	private static current: RelayWebSocket | undefined;

	readyState = RelayWebSocket.CONNECTING;
	binaryType: BinaryType = 'blob';
	readonly bufferedAmount = 0;
	readonly extensions = '';
	readonly protocol = '';
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	private readonly unsubscribe: () => void;

	constructor(readonly url: string) {
		super();
		RelayWebSocket.current?.close(1000, 'replaced');
		RelayWebSocket.current = this;
		this.unsubscribe = onMessage((message) => this.onHostMessage(message));
		post({ kind: 'console.socket', action: 'open' });
	}

	private onHostMessage(message: HostToWebview): void {
		if (this.readyState === RelayWebSocket.CLOSED) return;
		if (message.kind === 'console.status') {
			if (message.status === 'open' && this.readyState === RelayWebSocket.CONNECTING) {
				this.readyState = RelayWebSocket.OPEN;
				this.emit(new Event('open'));
			} else if (message.status === 'closed') {
				this.finish(1000, 'closed by the host', true);
			} else if (message.status === 'error') {
				this.emit(new Event('error'));
				this.finish(1006, message.message ?? 'connection failed', false);
			}
		} else if (message.kind === 'console.data' && this.readyState === RelayWebSocket.OPEN) {
			// Copy into an ArrayBuffer of this realm: the client checks `instanceof ArrayBuffer`.
			const data = new Uint8Array(message.data.byteLength);
			data.set(message.data);
			this.emit(new MessageEvent('message', { data: this.binaryType === 'arraybuffer' ? data.buffer : new Blob([data]) }));
		}
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.readyState !== RelayWebSocket.OPEN) throw new DOMException('WebSocket is not open', 'InvalidStateError');
		if (typeof data === 'string') {
			post({ kind: 'console.input', data: new TextEncoder().encode(data) });
		} else if (data instanceof Blob) {
			void data.arrayBuffer().then((buffer) => post({ kind: 'console.input', data: new Uint8Array(buffer) }));
		} else {
			// Views may point into WebAssembly memory that is reused right after `send` returns.
			const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
			post({ kind: 'console.input', data: view.slice() });
		}
	}

	close(code = 1000, reason = ''): void {
		if (this.readyState === RelayWebSocket.CLOSED) return;
		post({ kind: 'console.socket', action: 'close' });
		this.finish(code, reason, true);
	}

	private finish(code: number, reason: string, wasClean: boolean): void {
		if (this.readyState === RelayWebSocket.CLOSED) return;
		this.readyState = RelayWebSocket.CLOSED;
		this.unsubscribe();
		if (RelayWebSocket.current === this) RelayWebSocket.current = undefined;
		this.emit(new CloseEvent('close', { code, reason, wasClean }));
	}

	private emit(event: Event): void {
		this.dispatchEvent(event);
		const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
		if (typeof handler === 'function') handler.call(this, event);
	}
}

/** Replaces the page's `WebSocket` with the relay; returns a function restoring the original. */
export function installRelayWebSocket(): () => void {
	const original = globalThis.WebSocket;
	globalThis.WebSocket = RelayWebSocket as unknown as typeof WebSocket;
	return () => {
		globalThis.WebSocket = original;
	};
}
