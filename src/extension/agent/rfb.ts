/**
 * A small VNC (RFB 3.3 / 3.7 / 3.8) client for the extension host: enough to capture the screen and send
 * keys and pointer events on behalf of an AI agent. It talks over the same byte stream the providers give the
 * console (`openConsole(…, 'vnc')`), so it works for every provider with a VNC display. It asks to share the
 * display, so a console the user has open stays connected.
 *
 * Supported: security None and VNC authentication; Raw and CopyRect encodings, DesktopSize. No `vscode` import.
 */
import { createCipheriv } from 'node:crypto';
import type { Duplex } from 'node:stream';

export interface Frame {
	width: number;
	height: number;
	/** 4 bytes per pixel: blue, green, red, unused (the pixel format this client asks for). */
	pixels: Buffer;
}

const ENCODING_RAW = 0;
const ENCODING_COPYRECT = 1;
const ENCODING_DESKTOP_SIZE = -223;

/** Buffered reads of exact byte counts from a stream. */
class Reader {
	private chunks: Buffer[] = [];
	private size = 0;
	private waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
	private failed: Error | undefined;

	constructor(stream: Duplex) {
		stream.on('data', (chunk: Buffer) => {
			this.chunks.push(chunk);
			this.size += chunk.length;
			this.pump();
		});
		const end = (error?: Error) => {
			this.failed ??= error ?? new Error('The VNC connection closed.');
			if (this.waiting) {
				const { reject } = this.waiting;
				this.waiting = undefined;
				reject(this.failed);
			}
		};
		stream.on('error', end);
		stream.on('close', () => end());
		stream.on('end', () => end());
	}

	read(n: number): Promise<Buffer> {
		if (this.waiting) return Promise.reject(new Error('Concurrent VNC reads.'));
		return new Promise((resolve, reject) => {
			this.waiting = { n, resolve, reject };
			this.pump();
			if (this.waiting && this.failed) {
				this.waiting = undefined;
				reject(this.failed);
			}
		});
	}

	private pump(): void {
		if (!this.waiting || this.size < this.waiting.n) return;
		const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
		const { n, resolve } = this.waiting;
		this.waiting = undefined;
		const rest = all.subarray(n);
		this.chunks = rest.length ? [rest] : [];
		this.size = rest.length;
		resolve(all.subarray(0, n));
	}
}

/** The DES key VNC authentication uses: the password's first 8 bytes, each byte's bits mirrored. */
export function vncAuthResponse(challenge: Buffer, password: string): Buffer {
	const key = Buffer.alloc(8);
	Buffer.from(password, 'latin1').copy(key, 0, 0, 8);
	for (let i = 0; i < 8; i++) {
		let b = key[i];
		let r = 0;
		for (let bit = 0; bit < 8; bit++) {
			r = (r << 1) | (b & 1);
			b >>= 1;
		}
		key[i] = r;
	}
	const cipher = createCipheriv('des-ecb', key, null);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

export class RfbClient {
	private reader: Reader;
	width = 0;
	height = 0;
	name = '';
	private pixels = Buffer.alloc(0);
	private updateWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
	private closed: Error | undefined;

	private constructor(private readonly stream: Duplex) {
		this.reader = new Reader(stream);
	}

	/** Connects and handshakes. Rejects with a readable reason (auth failed, unsupported security, closed). */
	static async connect(stream: Duplex, options: { password?: string; timeoutMs?: number } = {}): Promise<RfbClient> {
		const client = new RfbClient(stream);
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				client.handshake(options.password),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('The VNC display did not answer in time.')), options.timeoutMs ?? 15_000);
				})
			]);
		} catch (error) {
			stream.destroy();
			throw error;
		} finally {
			clearTimeout(timer);
		}
		void client.loop();
		return client;
	}

	private async reason(): Promise<string> {
		const length = (await this.reader.read(4)).readUInt32BE(0);
		return (await this.reader.read(Math.min(length, 4096))).toString('utf8');
	}

	private async handshake(password: string | undefined): Promise<void> {
		const banner = (await this.reader.read(12)).toString('latin1');
		const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
		if (!match) throw new Error('This is not a VNC display.');
		const minor = Number(match[1]) > 3 ? 8 : Number(match[2]);
		const version = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
		this.stream.write(`RFB 003.00${version}\n`);

		let type: number;
		if (version === 3) {
			type = (await this.reader.read(4)).readUInt32BE(0);
			if (type === 0) throw new Error(`The VNC display refused the connection: ${await this.reason()}`);
		} else {
			const count = (await this.reader.read(1))[0];
			if (count === 0) throw new Error(`The VNC display refused the connection: ${await this.reason()}`);
			const offered = [...(await this.reader.read(count))];
			type = offered.includes(1) ? 1 : offered.includes(2) ? 2 : 0;
			if (!type) throw new Error(`The VNC display asks for a sign-in VM Manager does not support (security types ${offered.join(', ')}).`);
			this.stream.write(Buffer.from([type]));
		}
		if (type === 2) {
			if (password === undefined) throw new Error('The VNC display needs a password and the provider gave none.');
			this.stream.write(vncAuthResponse(await this.reader.read(16), password));
		} else if (type !== 1) {
			throw new Error(`The VNC display asks for a sign-in VM Manager does not support (security type ${type}).`);
		}
		if (type === 2 || version === 8) {
			const result = (await this.reader.read(4)).readUInt32BE(0);
			if (result !== 0) throw new Error(version === 8 ? `VNC sign-in failed: ${await this.reason()}` : 'VNC sign-in failed.');
		}

		this.stream.write(Buffer.from([1])); // ClientInit: share the display with other viewers
		const init = await this.reader.read(24);
		this.resize(init.readUInt16BE(0), init.readUInt16BE(2));
		this.name = (await this.reader.read(init.readUInt32BE(20))).toString('utf8');

		// SetPixelFormat: 32 bits per pixel, little endian, true colour, 8 bits per channel → B, G, R, X bytes.
		const format = Buffer.alloc(20);
		format[0] = 0;
		format.set([32, 24, 0, 1], 4);
		format.writeUInt16BE(255, 8);
		format.writeUInt16BE(255, 10);
		format.writeUInt16BE(255, 12);
		format.set([16, 8, 0], 14);
		const encodings = [ENCODING_RAW, ENCODING_COPYRECT, ENCODING_DESKTOP_SIZE];
		const setEncodings = Buffer.alloc(4 + 4 * encodings.length);
		setEncodings[0] = 2;
		setEncodings.writeUInt16BE(encodings.length, 2);
		encodings.forEach((e, i) => setEncodings.writeInt32BE(e, 4 + 4 * i));
		this.stream.write(Buffer.concat([format, setEncodings]));
	}

	private resize(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.pixels = Buffer.alloc(width * height * 4);
	}

	/** Reads server messages until the connection ends. */
	private async loop(): Promise<void> {
		try {
			for (;;) {
				const type = (await this.reader.read(1))[0];
				switch (type) {
					case 0:
						await this.frameUpdate();
						break;
					case 1: {
						const head = await this.reader.read(5);
						await this.reader.read(head.readUInt16BE(3) * 6);
						break;
					}
					case 2:
						break;
					case 3: {
						const head = await this.reader.read(7);
						await this.reader.read(head.readUInt32BE(3));
						break;
					}
					default:
						throw new Error(`Unexpected VNC message ${type}.`);
				}
			}
		} catch (error) {
			this.closed = error instanceof Error ? error : new Error(String(error));
			for (const w of this.updateWaiters.splice(0)) w.reject(this.closed);
			this.stream.destroy();
		}
	}

	private async frameUpdate(): Promise<void> {
		const count = (await this.reader.read(3)).readUInt16BE(1);
		for (let i = 0; i < count; i++) {
			const rect = await this.reader.read(12);
			const x = rect.readUInt16BE(0);
			const y = rect.readUInt16BE(2);
			const w = rect.readUInt16BE(4);
			const h = rect.readUInt16BE(6);
			const encoding = rect.readInt32BE(8);
			if (encoding === ENCODING_RAW) {
				const data = await this.reader.read(w * h * 4);
				for (let row = 0; row < h; row++) {
					if (y + row >= this.height) break;
					const width = Math.min(w, this.width - x) * 4;
					if (width > 0) data.copy(this.pixels, ((y + row) * this.width + x) * 4, row * w * 4, row * w * 4 + width);
				}
			} else if (encoding === ENCODING_COPYRECT) {
				const src = await this.reader.read(4);
				const sx = src.readUInt16BE(0);
				const sy = src.readUInt16BE(2);
				const copy = Buffer.alloc(w * h * 4);
				for (let row = 0; row < h; row++) this.pixels.copy(copy, row * w * 4, ((sy + row) * this.width + sx) * 4, ((sy + row) * this.width + sx + w) * 4);
				for (let row = 0; row < h; row++) copy.copy(this.pixels, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4);
			} else if (encoding === ENCODING_DESKTOP_SIZE) {
				this.resize(w, h);
			} else {
				throw new Error(`The VNC display sent an encoding VM Manager did not ask for (${encoding}).`);
			}
		}
		for (const w of this.updateWaiters.splice(0)) w.resolve();
	}

	/** The whole screen, fresh from the display. */
	async capture(timeoutMs = 10_000): Promise<Frame> {
		if (this.closed) throw this.closed;
		const updated = new Promise<void>((resolve, reject) => this.updateWaiters.push({ resolve, reject }));
		const request = Buffer.alloc(10);
		request[0] = 3;
		request[1] = 0; // not incremental: the whole area
		request.writeUInt16BE(this.width, 6);
		request.writeUInt16BE(this.height, 8);
		this.stream.write(request);
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([updated, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('The VNC display sent no picture in time.')), timeoutMs)))]);
		} finally {
			clearTimeout(timer);
		}
		return { width: this.width, height: this.height, pixels: Buffer.from(this.pixels) };
	}

	key(keysym: number, down: boolean): void {
		const message = Buffer.alloc(8);
		message[0] = 4;
		message[1] = down ? 1 : 0;
		message.writeUInt32BE(keysym >>> 0, 4);
		this.write(message);
	}

	/** `buttons`: bit 0 left, 1 middle, 2 right, 3 wheel up, 4 wheel down. Coordinates in screen pixels. */
	pointer(x: number, y: number, buttons: number): void {
		const message = Buffer.alloc(6);
		message[0] = 5;
		message[1] = buttons;
		message.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
		message.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
		this.write(message);
	}

	get isOpen(): boolean {
		return !this.closed && !this.stream.destroyed;
	}

	private write(message: Buffer): void {
		if (this.closed) throw this.closed;
		this.stream.write(message);
	}

	close(): void {
		this.closed ??= new Error('The VNC connection closed.');
		this.stream.destroy();
	}
}
