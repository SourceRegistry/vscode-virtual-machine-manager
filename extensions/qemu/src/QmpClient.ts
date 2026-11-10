import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';

export interface QmpEvent {
	event: string;
	data?: Record<string, unknown>;
	timestamp?: { seconds: number; microseconds: number };
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export class QmpError extends Error {
	constructor(
		message: string,
		readonly errorClass?: string
	) {
		super(message);
		this.name = 'QmpError';
	}
}

/**
 * Minimal QEMU Machine Protocol client (JSON lines over TCP). Emits `event` for asynchronous
 * QMP events (SHUTDOWN, RESET, STOP, RESUME, …) and `close` when the connection ends.
 */
export class QmpClient extends EventEmitter {
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();
	private greeting: ((value: void) => void) | undefined;
	private closed = false;

	private constructor(private readonly socket: Duplex) {
		super();
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => this.onData(chunk));
		socket.on('close', () => this.onClose());
		socket.on('error', () => this.onClose());
	}

	static connect(port: number, host = '127.0.0.1', timeoutMs = 3000): Promise<QmpClient> {
		return QmpClient.open(net.connect({ port, host }), timeoutMs);
	}

	/** Connects to a unix domain socket (Linux/macOS) or named pipe path. */
	static connectSocket(socketPath: string, timeoutMs = 3000): Promise<QmpClient> {
		return QmpClient.open(net.connect({ path: socketPath }), timeoutMs);
	}

	/** Talks QMP over a stream that is already connected (an ssh tunnel). */
	static attach(stream: Duplex, timeoutMs = 3000): Promise<QmpClient> {
		return QmpClient.open(stream, timeoutMs);
	}

	/** Performs the QMP handshake on a connecting socket. */
	private static open(socket: Duplex, timeoutMs: number): Promise<QmpClient> {
		return new Promise((resolve, reject) => {
			const client = new QmpClient(socket);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new QmpError('Timed out connecting to QMP'));
			}, timeoutMs);
			socket.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
			client.greeting = () => {
				client
					.execute('qmp_capabilities')
					.then(() => {
						clearTimeout(timer);
						resolve(client);
					})
					.catch((error: Error) => {
						clearTimeout(timer);
						socket.destroy();
						reject(error);
					});
			};
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	execute<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
		if (this.closed) return Promise.reject(new QmpError('QMP connection closed'));
		const id = `vmm-${this.nextId++}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.socket.write(`${JSON.stringify(args ? { execute: command, arguments: args, id } : { execute: command, id })}\n`);
		});
	}

	close(): void {
		this.socket.destroy();
		this.onClose();
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if ('QMP' in message) {
				const greeting = this.greeting;
				this.greeting = undefined;
				greeting?.();
			} else if ('event' in message) {
				this.emit('event', message as unknown as QmpEvent);
			} else if (typeof message.id === 'string' && this.pending.has(message.id)) {
				const pending = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				if ('error' in message) {
					const error = message.error as { class?: string; desc?: string };
					pending.reject(new QmpError(error.desc ?? 'QMP command failed', error.class));
				} else {
					pending.resolve(message.return);
				}
			}
		}
	}

	private onClose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(new QmpError('QMP connection closed'));
		this.pending.clear();
		this.emit('close');
	}
}
