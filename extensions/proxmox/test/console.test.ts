import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Client, DisplaySession, TerminalSession } from 'pve-client';
import { consoleStream } from '../src/console';
import { ProxmoxConnection } from '../src/ProxmoxProvider';
import { tokenTerminal } from '../src/terminal';
vi.mock('../src/terminal', () => ({ tokenTerminal: vi.fn() }));

class Session extends EventEmitter {
	write = vi.fn((_data: string | Buffer) => true);
	close = vi.fn(() => this.emit('close'));
}

function fixture(serial = 'socket') {
	const session = new Session();
	const open = vi.fn(async () => { setTimeout(() => session.emit('ready'), 0); return session; });
	const display = { open, ticket: { ticket: 'ephemeral-ticket' } };
	const consoleClient = { helpers: { display: vi.fn(() => display), terminal: vi.fn(() => ({ open })) } };
	vi.mocked(tokenTerminal).mockReturnValue(Object.assign(session, { start: async () => { setTimeout(() => session.emit('ready'), 0); } }) as unknown as TerminalSession);
	const client = { ...consoleClient, api: { nodes: { get: () => ({ qemu: { vmid: () => ({ config: { get: async () => ({ serial0: serial }) } }) } }) } }, events: { stopListening() {} } } as unknown as Client;
	const connection = new ProxmoxConnection(client, 'https://pve.test:8006', async () => {}, () => {}, true);
	return { connection, session, open };
}

describe('Proxmox console transport', () => {
	it('relays binary VNC bytes and closes the helper', () => {
		const session = new Session();
		const console = consoleStream(session as unknown as DisplaySession, false);
		const data = Buffer.from([0, 255, 128]);
		session.emit('data', data);
		expect(console.stream.read()).toEqual(data);
		console.stream.write(data);
		expect(session.write).toHaveBeenCalledWith(data);
		console.dispose();
		expect(session.close).toHaveBeenCalledOnce();
	});
	it('preserves UTF-8 split across serial writes', () => {
		const session = new Session();
		const console = consoleStream(session as unknown as TerminalSession, true);
		const text = Buffer.from('€');
		console.stream.write(text.subarray(0, 1));
		console.stream.write(text.subarray(1));
		expect(session.write.mock.calls.map(([chunk]) => chunk).join('')).toBe('€');
		console.dispose();
	});
	it('provides the VNC ticket and honors certificate verification', async () => {
		const { connection, open } = fixture();
		const console = await connection.openConsole('pve', '100', 'vnc');
		expect(console.credentials).toEqual({ password: 'ephemeral-ticket' });
		expect(open).toHaveBeenCalledWith({ rejectUnauthorized: true });
		console.dispose();
		await connection.openConsole('pve', '100', 'vnc');
		expect(open).toHaveBeenCalledTimes(2);
		connection.dispose();
	});
	it('opens a serial terminal and rejects missing serial sockets', async () => {
		const { connection } = fixture();
		const console = await connection.openConsole('pve', '100', 'serial');
		expect(console.credentials).toBeUndefined();
		connection.dispose();
		const missing = fixture('');
		await expect(missing.connection.openConsole('pve', '100', 'serial')).rejects.toThrow('serial socket');
	});
	it('reports handshake failures and releases failed sessions', async () => {
		const { connection, session, open } = fixture();
		open.mockImplementationOnce(async () => { setTimeout(() => session.emit('error', new Error('denied')), 0); return session; });
		const promise = connection.openConsole('pve', '100', 'vnc');
		await expect(promise).rejects.toThrow();
		connection.dispose();
	});
});
