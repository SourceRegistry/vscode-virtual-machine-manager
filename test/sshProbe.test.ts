import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort, probeSsh } from '../src/extension/ssh/probe';

const servers: net.Server[] = [];
const listen = (onConnection: (socket: net.Socket) => void): Promise<number> =>
	new Promise((resolve) => {
		const server = net.createServer(onConnection);
		servers.push(server);
		server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
	});

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

describe('probeSsh', () => {
	it('recognises an SSH server by its identification line', async () => {
		const port = await listen((s) => s.write('SSH-2.0-OpenSSH_9.2p1 Debian\r\n'));
		expect(await probeSsh('127.0.0.1', port)).toEqual({ ok: true, banner: 'SSH-2.0-OpenSSH_9.2p1 Debian' });
	});

	it('copes with the banner arriving in pieces', async () => {
		const port = await listen((s) => {
			s.write('SSH-2.0-Open');
			setTimeout(() => s.write('SSH_9\n'), 50);
		});
		expect(await probeSsh('127.0.0.1', port)).toEqual({ ok: true, banner: 'SSH-2.0-OpenSSH_9' });
	});

	it('reports a listener that stays silent, like a forward with no sshd behind it', async () => {
		const port = await listen(() => undefined);
		const started = Date.now();
		expect(await probeSsh('127.0.0.1', port, 300)).toEqual({ ok: false, reason: 'silent' });
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it('reports a server that closes at once as silent', async () => {
		const port = await listen((s) => s.end());
		expect(await probeSsh('127.0.0.1', port, 2000)).toEqual({ ok: false, reason: 'silent' });
	});

	it('reports something that is not SSH', async () => {
		const port = await listen((s) => s.write('HTTP/1.1 400 Bad Request\r\n'));
		expect(await probeSsh('127.0.0.1', port)).toMatchObject({ ok: false, reason: 'notSsh' });
	});

	it('reports a refused connection', async () => {
		const port = await listen(() => undefined);
		servers.pop()!.close();
		await new Promise((r) => setTimeout(r, 50));
		expect(await probeSsh('127.0.0.1', port)).toMatchObject({ ok: false, reason: 'refused' });
	});
});

describe('findFreePort', () => {
	it('skips ports that are taken or already listening', async () => {
		const busy = await listen(() => undefined);
		const found = await findFreePort(busy, [busy + 1]);
		expect(found).toBeGreaterThan(busy + 1);
		expect(found).not.toBe(busy);
	});
});
