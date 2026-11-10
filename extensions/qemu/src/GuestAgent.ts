import * as net from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Minimal QEMU guest agent (QGA) client. The agent speaks JSON lines over a virtio-serial port that
 * QEMU exposes as a localhost TCP socket. There is no greeting, so the connection is first
 * synchronised with `guest-sync-delimited`: the agent answers with the same id once it is alive,
 * which doubles as a liveness check (a guest without the agent never answers).
 */
export class GuestAgentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GuestAgentError';
	}
}

const DELIMITER = '\xff';

export class GuestAgentClient {
	private buffer = '';
	private waiter: { id: number; resolve: () => void; reject: (e: Error) => void } | undefined;
	private readonly replies: Array<(message: Record<string, unknown>) => void> = [];

	private constructor(private readonly socket: Duplex) {
		socket.setEncoding('latin1');
		socket.on('data', (chunk: string) => this.onData(chunk));
		socket.on('close', () => this.fail(new GuestAgentError('Guest agent connection closed')));
		socket.on('error', () => this.fail(new GuestAgentError('Guest agent connection failed')));
	}

	/** Connects and verifies that an agent answers within `timeoutMs`. Rejects otherwise. */
	static async connect(port: number, timeoutMs = 2000, host = '127.0.0.1'): Promise<GuestAgentClient> {
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.connect({ port, host });
			s.once('connect', () => resolve(s));
			s.once('error', reject);
		});
		const client = new GuestAgentClient(socket);
		try {
			await client.sync(timeoutMs);
		} catch (error) {
			client.close();
			throw error;
		}
		return client;
	}

	/** Same as `connect`, over a stream that is already connected (an ssh tunnel). */
	static async over(stream: Duplex, timeoutMs = 2000): Promise<GuestAgentClient> {
		const client = new GuestAgentClient(stream);
		try {
			await client.sync(timeoutMs);
		} catch (error) {
			client.close();
			throw error;
		}
		return client;
	}

	private sync(timeoutMs: number): Promise<void> {
		const id = Math.floor(Math.random() * 0x7fffffff);
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiter = undefined;
				reject(new GuestAgentError('No guest agent answered'));
			}, timeoutMs);
			this.waiter = {
				id,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				}
			};
			// The leading delimiter makes the agent discard anything half-written before it.
			// latin1 so the delimiter is the single byte 0xFF (UTF-8 would encode it as two bytes).
			this.socket.write(`${DELIMITER}${JSON.stringify({ execute: 'guest-sync-delimited', arguments: { id } })}\n`, 'latin1');
		});
	}

	/**
	 * `guest-shutdown` never replies when it succeeds (the guest goes down first), so this resolves
	 * once the request is written.
	 */
	async shutdown(mode: 'powerdown' | 'reboot' | 'halt' = 'powerdown'): Promise<void> {
		await new Promise<void>((resolve, reject) =>
			this.socket.write(`${JSON.stringify({ execute: 'guest-shutdown', arguments: { mode } })}\n`, (error) =>
				error ? reject(error) : resolve()
			)
		);
	}

	/** Executes a command that replies. */
	execute<T = unknown>(command: string, args?: Record<string, unknown>, timeoutMs = 3000): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new GuestAgentError(`${command} timed out`)), timeoutMs);
			this.replies.push((message) => {
				clearTimeout(timer);
				if ('error' in message) reject(new GuestAgentError(String((message.error as { desc?: string }).desc ?? command)));
				else resolve(message.return as T);
			});
			this.socket.write(`${JSON.stringify(args ? { execute: command, arguments: args } : { execute: command })}\n`);
		});
	}

	close(): void {
		this.socket.destroy();
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, index).replace(/\xff/g, '').trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (this.waiter && message.return === this.waiter.id) {
				const waiter = this.waiter;
				this.waiter = undefined;
				waiter.resolve();
			} else if (!this.waiter) {
				this.replies.shift()?.(message);
			}
		}
	}

	private fail(error: Error): void {
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.reject(error);
	}
}
