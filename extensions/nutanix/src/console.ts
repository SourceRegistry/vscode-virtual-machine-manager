import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { ProviderError, type ConsoleStream } from '@vmm/sdk';

/**
 * Prism's VNC proxy: the same websocket the Prism console page (noVNC) opens. Through Prism Central the
 * VM's cluster is named with `proxyClusterUuid`; Prism Element serves its own VMs without it.
 */
export function vncProxyUrl(baseUrl: string, vmId: string, clusterId: string | undefined): string {
	const url = new URL(`/vnc/vm/${encodeURIComponent(vmId)}/proxy`, baseUrl);
	url.protocol = 'wss:';
	if (clusterId) url.searchParams.set('proxyClusterUuid', clusterId);
	return url.toString();
}

/** A websocket carrying raw RFB in binary frames, adapted to the core's console byte stream. */
export function websocketConsole(socket: WebSocket): ConsoleStream {
	let disposed = false;
	const stream = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, callback) {
			if (socket.readyState !== WebSocket.OPEN) { callback(new Error('The Prism console connection is closed.')); return; }
			socket.send(chunk, { binary: true }, (error) => callback(error ?? null));
		},
		destroy(error, callback) { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate(); callback(error); }
	});
	// The core attaches its error listener after openConsole returns.
	stream.on('error', () => {});
	socket.on('message', (data: WebSocket.RawData) => stream.push(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)));
	socket.on('error', (error) => stream.destroy(error));
	socket.on('close', () => { stream.push(null); stream.destroy(); });
	return { stream, dispose() { if (!disposed) { disposed = true; stream.destroy(); } } };
}

/** Opens the VNC proxy and resolves once the websocket is open. */
export async function openVncConsole(url: string, headers: Record<string, string>, verifyTls: boolean, signal?: AbortSignal): Promise<ConsoleStream> {
	const socket = new WebSocket(url, { headers: { ...headers, Origin: new URL(url.replace(/^wss:/, 'https:')).origin }, rejectUnauthorized: verifyTls, handshakeTimeout: 30_000 });
	const console = websocketConsole(socket);
	try {
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(new ProviderError('Console connection cancelled.', 'failed'));
			signal?.addEventListener('abort', abort, { once: true });
			socket.once('open', () => { signal?.removeEventListener('abort', abort); resolve(); });
			socket.once('unexpected-response', (_request, response) => {
				const status = response.statusCode ?? 0;
				reject(status === 401 || status === 403
					? new ProviderError('Prism rejected console access for the signed-in user. It needs permission to access the VM console.', 'permission')
					: new ProviderError(`Prism refused the console connection (HTTP ${status}).`, status === 404 ? 'unsupported' : 'failed'));
			});
			socket.once('error', reject);
		});
		return console;
	} catch (error) {
		console.dispose();
		throw error;
	}
}
