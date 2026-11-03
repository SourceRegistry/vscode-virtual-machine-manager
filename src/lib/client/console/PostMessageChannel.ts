import { post } from '../rpc/bridge';

type ChannelState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * WebSocket-like channel for noVNC (`new RFB(target, channel)`). Bytes are relayed through the
 * extension host, which owns the real TCP / named-pipe / websocket connection to the hypervisor.
 *
 * noVNC checks for these properties as own keys, so they are class fields, not getters.
 */
export class PostMessageChannel {
	binaryType = 'arraybuffer';
	protocol = '';
	readyState: ChannelState = 'connecting';
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
	onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	private queue: ArrayBuffer[] = [];

	send(data: ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== 'open') return;
		const view =
			data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		// noVNC reuses its send buffer; copy before handing it to postMessage.
		post({ kind: 'console.input', data: view.slice() });
	}

	close(): void {
		if (this.readyState === 'closed') return;
		this.readyState = 'closed';
		setTimeout(() => this.onclose?.({ code: 1000, reason: '', wasClean: true }));
	}

	/** Host reported that the upstream connection is open. */
	markOpen(): void {
		if (this.readyState !== 'connecting') return;
		this.readyState = 'open';
		this.onopen?.(new Event('open'));
		const queued = this.queue;
		this.queue = [];
		for (const data of queued) this.onmessage?.({ data });
	}

	receive(bytes: Uint8Array): void {
		const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		if (this.readyState === 'open') this.onmessage?.({ data });
		else if (this.readyState === 'connecting') this.queue.push(data);
	}

	/** Host reported that the upstream connection closed or failed. */
	markClosed(error?: string): void {
		if (this.readyState === 'closed') return;
		this.readyState = 'closed';
		if (error) this.onerror?.(new Event('error'));
		this.onclose?.({ code: error ? 1006 : 1000, reason: error ?? '', wasClean: !error });
	}
}
