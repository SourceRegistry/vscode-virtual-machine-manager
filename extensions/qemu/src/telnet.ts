/**
 * Minimal telnet client side for QEMU's `telnet:` / `telnet=on` serial sockets: strips the option
 * negotiation QEMU sends (IAC WILL ECHO, …) from the guest's output and escapes 0xFF in input.
 * No option is negotiated back; QEMU does not wait for answers. Pure parser plus a stream wrapper.
 */
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';

const IAC = 0xff;
const SB = 0xfa;
const SE = 0xf0;
const WILL = 0xfb;
const DONT = 0xfe;

type State = 'data' | 'iac' | 'option' | 'sub' | 'subIac';

/** Stateful: a command split across two chunks is still removed. */
export class TelnetFilter {
	private state: State = 'data';

	/** Guest output with telnet commands removed (`IAC IAC` → one 0xFF byte). */
	feed(chunk: Buffer): Buffer {
		const out = Buffer.allocUnsafe(chunk.length);
		let n = 0;
		for (const byte of chunk) {
			switch (this.state) {
				case 'data':
					if (byte === IAC) this.state = 'iac';
					else out[n++] = byte;
					break;
				case 'iac':
					if (byte === IAC) {
						out[n++] = IAC;
						this.state = 'data';
					} else if (byte >= WILL && byte <= DONT) this.state = 'option';
					else if (byte === SB) this.state = 'sub';
					else this.state = 'data';
					break;
				case 'option':
					this.state = 'data';
					break;
				case 'sub':
					if (byte === IAC) this.state = 'subIac';
					break;
				case 'subIac':
					this.state = byte === SE ? 'data' : 'sub';
					break;
			}
		}
		return out.subarray(0, n);
	}
}

/** Input for the guest: a literal 0xFF byte must be sent as `IAC IAC`. */
export function escapeTelnet(chunk: Buffer): Buffer {
	if (!chunk.includes(IAC)) return chunk;
	const out: number[] = [];
	for (const byte of chunk) {
		out.push(byte);
		if (byte === IAC) out.push(IAC);
	}
	return Buffer.from(out);
}

/** `socket` seen as a plain byte stream: telnet commands removed on read, 0xFF escaped on write. */
export function telnetStream(socket: Duplex | Socket): Duplex {
	const filter = new TelnetFilter();
	const stream = new Duplex({
		read() {
			socket.resume();
		},
		write(chunk: Buffer, _encoding, callback) {
			socket.write(escapeTelnet(chunk), callback);
		},
		final(callback) {
			socket.end();
			callback();
		},
		destroy(error, callback) {
			socket.destroy();
			callback(error);
		}
	});
	socket.on('data', (data: Buffer) => {
		const clean = filter.feed(data);
		if (clean.length && !stream.push(clean)) socket.pause();
	});
	socket.once('end', () => stream.push(null));
	socket.once('error', (error) => stream.destroy(error));
	return stream;
}
