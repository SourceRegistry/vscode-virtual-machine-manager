import { PassThrough, Duplex } from 'node:stream';
import { createDecipheriv, getCiphers } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RfbClient, vncAuthResponse } from '../src/extension/agent/rfb';
import { crc32, framePng, screenshotSize, toScreen } from '../src/extension/agent/screen';
import { comboStrokes, textStrokes } from '../src/extension/agent/keys';
import { DisplaySessions } from '../src/extension/agent/display';

/** Two connected streams: what one side writes, the other reads. */
function pipe(): [Duplex, Duplex] {
	const a = new PassThrough();
	const b = new PassThrough();
	const end = (read: PassThrough, write: PassThrough) =>
		new Duplex({
			read() {},
			write(chunk, _enc, done) {
				write.write(chunk);
				done();
			},
			destroy(err, done) {
				write.end();
				done(err);
			}
		}).on('pipe', () => undefined);
	const client = end(a, b);
	const server = end(b, a);
	a.on('data', (d) => client.push(d));
	b.on('data', (d) => server.push(d));
	b.on('end', () => server.push(null));
	a.on('end', () => client.push(null));
	return [client, server];
}

/** A VNC server with a 4 × 2 screen, enough of RFB 3.8 for the client. */
class FakeVnc {
	received: Buffer[] = [];
	private buffered = Buffer.alloc(0);
	constructor(
		private readonly socket: Duplex,
		private readonly options: { password?: string; version?: string } = {}
	) {
		socket.on('data', (d: Buffer) => {
			this.received.push(d);
			this.buffered = Buffer.concat([this.buffered, d]);
			this.step();
		});
		socket.write(`RFB ${options.version ?? '003.008'}\n`);
	}
	private stage = 'version';
	private challenge = Buffer.from('0123456789abcdef');
	private take(n: number): Buffer | undefined {
		if (this.buffered.length < n) return undefined;
		const out = this.buffered.subarray(0, n);
		this.buffered = this.buffered.subarray(n);
		return out;
	}
	private step(): void {
		for (;;) {
			if (this.stage === 'version') {
				if (!this.take(12)) return;
				this.socket.write(Buffer.from([1, this.options.password ? 2 : 1]));
				this.stage = 'security';
			} else if (this.stage === 'security') {
				if (!this.take(1)) return;
				if (this.options.password) {
					this.socket.write(this.challenge);
					this.stage = 'auth';
				} else {
					this.socket.write(Buffer.alloc(4));
					this.stage = 'init';
				}
			} else if (this.stage === 'auth') {
				const answer = this.take(16);
				if (!answer) return;
				const ok = answer.equals(vncAuthResponse(this.challenge, this.options.password!));
				const result = Buffer.alloc(4);
				result.writeUInt32BE(ok ? 0 : 1);
				this.socket.write(result);
				if (!ok) {
					const reason = Buffer.from('bad password');
					const len = Buffer.alloc(4);
					len.writeUInt32BE(reason.length);
					this.socket.write(Buffer.concat([len, reason]));
					return;
				}
				this.stage = 'init';
			} else if (this.stage === 'init') {
				if (!this.take(1)) return;
				const init = Buffer.alloc(24);
				init.writeUInt16BE(4, 0);
				init.writeUInt16BE(2, 2);
				init.writeUInt32BE(4, 20);
				this.socket.write(Buffer.concat([init, Buffer.from('test')]));
				this.stage = 'messages';
			} else {
				const type = this.buffered[0];
				const size = { 0: 20, 2: 4 + 4 * (this.buffered.length >= 4 ? this.buffered.readUInt16BE(2) : 0), 3: 10, 4: 8, 5: 6 }[type as 0 | 2 | 3 | 4 | 5];
				if (size === undefined || this.buffered.length < 4) return;
				const message = this.take(size);
				if (!message) return;
				if (type === 3) this.sendFrame();
			}
		}
	}
	/** One update: the screen as a raw rectangle, red on the left half, blue on the right. */
	sendFrame(): void {
		const head = Buffer.alloc(4 + 12);
		head[0] = 0;
		head.writeUInt16BE(1, 2);
		head.writeUInt16BE(4, 8);
		head.writeUInt16BE(2, 10);
		head.writeInt32BE(0, 12);
		const pixels = Buffer.alloc(4 * 2 * 4);
		for (let i = 0; i < 8; i++) pixels.set(i % 4 < 2 ? [0, 0, 255, 0] : [255, 0, 0, 0], i * 4);
		this.socket.write(Buffer.concat([head, pixels]));
	}
}

describe('VNC client', () => {
	it('handshakes without a password, captures the screen and sends keys and pointer events', async () => {
		const [client, server] = pipe();
		const fake = new FakeVnc(server);
		const rfb = await RfbClient.connect(client);
		expect([rfb.width, rfb.height, rfb.name]).toEqual([4, 2, 'test']);
		const frame = await rfb.capture();
		expect([...frame.pixels.subarray(0, 4)]).toEqual([0, 0, 255, 0]);
		expect([...frame.pixels.subarray(12, 16)]).toEqual([255, 0, 0, 0]);
		rfb.key(0xff0d, true);
		rfb.pointer(3, 1, 1);
		await new Promise((r) => setTimeout(r, 20));
		const sent = Buffer.concat(fake.received);
		expect(sent.includes(Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]))).toBe(true);
		expect(sent.includes(Buffer.from([5, 1, 0, 3, 0, 1]))).toBe(true);
		// Shared session: ClientInit asks to share the display.
		expect(sent.includes(Buffer.from('RFB 003.008\n'))).toBe(true);
		rfb.close();
	});

	it.runIf(getCiphers().includes('des-ecb'))('signs in with VNC authentication, and says when the password is wrong', async () => {
		const [client, server] = pipe();
		new FakeVnc(server, { password: 'secret' });
		const rfb = await RfbClient.connect(client, { password: 'secret' });
		expect(rfb.width).toBe(4);
		rfb.close();
		const [client2, server2] = pipe();
		new FakeVnc(server2, { password: 'secret' });
		await expect(RfbClient.connect(client2, { password: 'wrong' })).rejects.toThrow(/VNC sign-in failed: bad password/);
	});

	it.runIf(getCiphers().includes('des-ecb'))('mirrors the key bits like every VNC server expects', () => {
		const response = vncAuthResponse(Buffer.alloc(16), 'pw');
		const key = Buffer.from([0x0e, 0xee, 0, 0, 0, 0, 0, 0]); // "p" = 0x70 → 0x0e, "w" = 0x77 → 0xee
		const decipher = createDecipheriv('des-ecb', key, null);
		decipher.setAutoPadding(false);
		expect(Buffer.concat([decipher.update(response), decipher.final()])).toEqual(Buffer.alloc(16));
	});

	it('rejects something that is not a VNC server', async () => {
		const [client, server] = pipe();
		server.write('SSH-2.0-OpenSSH\n');
		await expect(RfbClient.connect(client)).rejects.toThrow(/not a VNC display/);
	});
});

describe('screenshots', () => {
	it('keeps small screens as they are and scales large ones to 1280 on the longest side', () => {
		expect(screenshotSize(1280, 800)).toEqual({ width: 1280, height: 800 });
		expect(screenshotSize(2560, 1440)).toEqual({ width: 1280, height: 720 });
		expect(toScreen(640, 360, { width: 2560, height: 1440 })).toEqual({ x: 1280, y: 720 });
		expect(toScreen(10, 10, { width: 800, height: 600 })).toEqual({ x: 10, y: 10 });
		expect(() => toScreen(1280, 0, { width: 2560, height: 1440 })).toThrow(/outside the screen, which is 1280 × 720/);
	});

	it('encodes a valid PNG, averaging pixels when it scales down', () => {
		const width = 2560;
		const height = 2;
		const pixels = Buffer.alloc(width * height * 4);
		for (let i = 0; i < width * height; i++) pixels.set(i % 2 ? [0, 0, 200, 0] : [0, 0, 100, 0], i * 4);
		const { png, width: w, height: h } = framePng({ width, height, pixels });
		expect([w, h]).toEqual([1280, 1]);
		expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const ihdrCrc = png.readUInt32BE(8 + 8 + 13);
		expect(ihdrCrc).toBe(crc32(png.subarray(12, 12 + 4 + 13)));
		const idatLength = png.readUInt32BE(33);
		const rows = inflateSync(png.subarray(41, 41 + idatLength));
		expect(rows.length).toBe(1 + 1280 * 3);
		expect([...rows.subarray(1, 4)]).toEqual([150, 0, 0]);
	});

	it('computes the standard CRC-32', () => {
		expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
	});
});

describe('keys', () => {
	it('presses a combination and releases it in reverse', () => {
		expect(comboStrokes('ctrl+alt+Delete')).toEqual([
			{ keysym: 0xffe3, down: true }, { keysym: 0xffe9, down: true }, { keysym: 0xffff, down: true },
			{ keysym: 0xffff, down: false }, { keysym: 0xffe9, down: false }, { keysym: 0xffe3, down: false }
		]);
		expect(comboStrokes('F5')[0].keysym).toBe(0xffc2);
		expect(comboStrokes('ctrl+plus')[1].keysym).toBe(0x2b);
		expect(() => comboStrokes('ctrl+')).toThrow(/"plus"/);
	});

	it('types text with Shift where a US keyboard needs it, newlines as Enter', () => {
		expect(textStrokes('a!\n').map((s) => s.keysym)).toEqual([0x61, 0x61, 0xffe1, 0x21, 0x21, 0xffe1, 0xff0d, 0xff0d]);
		expect(textStrokes('€')[0].keysym).toBe(0x010020ac);
	});
});

describe('display sessions', () => {
	it('reuses one connection per machine and maps clicks from screenshot pixels', async () => {
		let opened = 0;
		let fake: FakeVnc | undefined;
		const open = async () => {
			opened++;
			const [client, server] = pipe();
			fake = new FakeVnc(server);
			return { stream: client, dispose: () => client.destroy() };
		};
		const displays = new DisplaySessions(60_000, 0);
		const shot = await displays.screenshot('vm', open);
		expect([shot.width, shot.height, shot.screen]).toEqual([4, 2, { width: 4, height: 2 }]);
		await displays.mouse('vm', open, { action: 'click', x: 3, y: 1 });
		await displays.keys('vm', open, textStrokes('a'));
		expect(opened).toBe(1);
		const sent = Buffer.concat(fake!.received);
		expect(sent.includes(Buffer.from([5, 1, 0, 3, 0, 1]))).toBe(true);
		expect(sent.includes(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]))).toBe(true);
		await expect(displays.mouse('vm', open, { action: 'click', x: 9, y: 0 })).rejects.toThrow(/outside the screen/);
		displays.dispose();
	});
});
