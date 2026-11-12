import { spawn, execFile } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { closeSync, constants, open } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';
import { Duplex } from 'node:stream';
import { ProviderError, type ConsoleStream } from '@vmm/sdk';
import type { SshTarget } from './uri';

export interface Endpoint { host?: string; port?: number; path?: string }

/** A TCP port on the libvirt host, reached through `ssh -W`: nothing listens on this computer. */
export function sshTunnel(target: SshTarget, host: string, port: number): Promise<Duplex> {
	return new Promise((resolve, reject) => {
		// `-W` is an option of ssh, so it goes before `--`, which ends the options ahead of the host name.
		const args = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', ...(target.port ? ['-p', String(target.port)] : []), '-W', `${host.includes(':') ? `[${host}]` : host}:${port}`, '--', `${target.user ? `${target.user}@` : ''}${target.host}`];
		const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		let stderr = '';
		let opened = false;
		child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-400); });
		const stream = new Duplex({
			read: () => child.stdout.resume(),
			write: (chunk, _encoding, callback) => { child.stdin.write(chunk, callback); },
			final: (callback) => { child.stdin.end(callback); },
			destroy: (error, callback) => { child.kill(); callback(error); }
		});
		child.stdout.on('data', (chunk: Buffer) => {
			if (!opened) { opened = true; clearTimeout(ready); resolve(stream); }
			if (!stream.push(chunk)) child.stdout.pause();
		});
		child.stdout.on('end', () => stream.push(null));
		const fail = (message: string) => { clearTimeout(ready); child.kill(); reject(new ProviderError(`${message}${stderr.trim() ? ` (${stderr.trim().split(/\r?\n/).pop()})` : ''}`, 'unavailable')); };
		child.once('error', (e) => fail(`Could not start ssh: ${e.message}`));
		child.once('exit', () => { if (!opened) fail(`The SSH tunnel to ${host}:${port} closed. Is the display listening there?`); else stream.destroy(); });
		// A VNC server speaks first, so the first byte means the tunnel works; a quiet port (a serial console) counts as up after a while.
		const ready = setTimeout(() => { if (!opened) { opened = true; resolve(stream); } }, 6000);
	});
}

function connectSocket(options: { host?: string; port?: number; path?: string }): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = options.path ? connect({ path: options.path }) : connect({ host: options.host ?? '127.0.0.1', port: options.port! });
		socket.once('connect', () => resolve(socket));
		socket.once('error', reject);
	});
}

/** A VNC or serial TCP/unix endpoint of the libvirt host, opened locally or through ssh. */
export async function openEndpoint(endpoint: Endpoint, ssh: SshTarget | undefined, what: string): Promise<ConsoleStream> {
	try {
		if (ssh) {
			if (endpoint.path) throw new ProviderError(`The ${what} is a socket on the host (${endpoint.path}); only network ports can be reached over SSH.`, 'unsupported');
			const stream = await sshTunnel(ssh, endpoint.host ?? '127.0.0.1', endpoint.port!);
			return { stream, dispose: () => stream.destroy() };
		}
		const socket = await connectSocket(endpoint);
		return { stream: socket, dispose: () => socket.destroy() };
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		throw new ProviderError(`Could not open the ${what} at ${endpoint.path ?? `${endpoint.host}:${endpoint.port}`}: ${(error as Error).message}`, 'unavailable');
	}
}

/** The serial console of a domain on this computer: a pseudo-terminal, put in raw mode so the guest does the echo. */
export async function openPty(path: string): Promise<ConsoleStream> {
	if (!/^\/dev\/[\w/.-]+$/.test(path)) throw new ProviderError(`Unexpected serial device ${path}.`, 'invalid');
	// tty streams wait for data on the event loop. A file stream would park a libuv threadpool thread in a blocking
	// read() that closing the file does not end, so a quiet guest would keep a thread per console ever opened.
	// One descriptor each way: each tty stream closes its own.
	const fds: number[] = [];
	let reader: ReadStream | undefined;
	let writer: WriteStream | undefined;
	try {
		for (let i = 0; i < 2; i++) fds.push(await new Promise<number>((resolve, reject) => open(path, constants.O_RDWR | constants.O_NOCTTY, (e, fd) => (e ? reject(e) : resolve(fd)))));
		reader = new ReadStream(fds[0]);
		writer = new WriteStream(fds[1]);
	} catch (e) {
		reader?.destroy();
		for (const fd of fds.slice(reader ? 1 : 0)) closeSync(fd);
		throw new ProviderError(`Could not open the serial console ${path}: ${(e as Error).message}. Another program may hold it.`, 'unavailable');
	}
	const stream = Duplex.from({ readable: reader, writable: writer });
	// Closing a terminal ends its pending read; that is not an error worth surfacing.
	reader.on('error', () => {});
	writer.on('error', () => {});
	stream.on('error', () => {});
	// Raw mode only after the open: a terminal nobody holds gets its default settings back when it is opened
	// (macOS), and with echo on, the guest's own output is echoed back to it as typing.
	await new Promise<void>((resolve) => {
		// BSD and GNU stty differ in how they name the device; the other one fails harmlessly.
		execFile('stty', [process.platform === 'darwin' ? '-f' : '-F', path, 'raw', '-echo'], () => resolve());
	});
	const r = reader, w = writer;
	return { stream, dispose: () => { r.destroy(); w.destroy(); stream.destroy(); } };
}
