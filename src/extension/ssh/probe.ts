import * as net from 'node:net';

export type SshProbe =
	| { ok: true; banner: string }
	| { ok: false; reason: 'refused' | 'silent' | 'notSsh' | 'unreachable'; detail?: string };

/**
 * Connects and waits for the SSH identification line (`SSH-2.0-…`), which a server sends first.
 *
 * That is more telling than a plain connect: QEMU's port forward accepts connections on the host
 * whether or not anything listens in the guest, so "connected" proves nothing. Silence means the
 * forward is there but sshd is not answering (not installed, not started, still booting).
 */
export function probeSsh(host: string, port: number, timeoutMs = 4000): Promise<SshProbe> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		let settled = false;
		const finish = (result: SshProbe) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish({ ok: false, reason: 'silent' }), timeoutMs);
		let received = '';
		socket.setEncoding('latin1');
		socket.on('data', (chunk: string) => {
			received += chunk;
			if (received.startsWith('SSH-')) {
				if (received.includes('\n')) finish({ ok: true, banner: received.split(/\r?\n/)[0]! });
			} else if (received.length >= 4) {
				finish({ ok: false, reason: 'notSsh', detail: received.slice(0, 40) });
			}
		});
		socket.on('error', (error: NodeJS.ErrnoException) => {
			finish({ ok: false, reason: error.code === 'ECONNREFUSED' ? 'refused' : 'unreachable', detail: error.code });
		});
		// A server that closes without a word is as good as silent.
		socket.on('close', () => finish({ ok: false, reason: 'silent' }));
	});
}

/** First port from `start` that nothing on this computer is listening on and that is not in `taken`. */
export async function findFreePort(start: number, taken: Iterable<number> = []): Promise<number> {
	const used = new Set(taken);
	for (let port = start; port < 65535; port++) {
		if (used.has(port)) continue;
		if (await canListen(port)) return port;
	}
	throw new Error('No free port found');
}

function canListen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
	});
}
