import { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { DisplaySession, TerminalSession } from 'pve-client';
import type { ConsoleStream } from '@vmm/sdk';

/** Adapt the helpers' authenticated sessions to the core's raw console byte stream. */
export function consoleStream(session: DisplaySession | TerminalSession, serial: boolean): ConsoleStream {
	const decoder = new StringDecoder('utf8');
	let disposed = false;
	const stream = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, callback) {
			try {
				if (serial) (session as TerminalSession).write(decoder.write(chunk));
				else (session as DisplaySession).write(chunk);
				callback();
			} catch (error) { callback(error as Error); }
		},
		destroy(error, callback) { session.close(); callback(error); }
	});
	// The core attaches its error listener after openConsole returns.
	stream.on('error', () => {});
	session.on('data', (data) => stream.push(data));
	session.on('error', (error) => stream.destroy(error));
	session.on('close', () => { stream.push(null); stream.destroy(); });
	return { stream, dispose() { if (!disposed) { disposed = true; stream.destroy(); } } };
}
