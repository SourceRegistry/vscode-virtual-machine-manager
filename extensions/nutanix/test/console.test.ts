import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { openVncConsole, vncProxyUrl } from '../src/console';

describe('Prism VNC proxy', () => {
	let server: WebSocketServer | undefined;
	afterEach(async () => { server?.clients.forEach((c) => c.terminate()); await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined)); server = undefined; });

	it('addresses the proxy of the VM, through its cluster on Prism Central', () => {
		expect(vncProxyUrl('https://pc.test:9440', 'vm-1', 'pe-1')).toBe('wss://pc.test:9440/vnc/vm/vm-1/proxy?proxyClusterUuid=pe-1');
		expect(vncProxyUrl('https://pe.test:9440', 'vm-1', undefined)).toBe('wss://pe.test:9440/vnc/vm/vm-1/proxy');
	});

	it('relays RFB bytes both ways and sends the sign-in with the upgrade', async () => {
		server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
		await once(server, 'listening');
		const headers = new Promise<Record<string, string | string[] | undefined>>((resolve) => server!.once('connection', (socket, request) => {
			socket.send(Buffer.from('RFB 003.008\n'));
			socket.on('message', (data) => socket.send(Buffer.concat([Buffer.from('echo:'), data as Buffer])));
			resolve(request.headers);
		}));
		const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/vnc/vm/x/proxy`;
		const console = await openVncConsole(url, { Authorization: 'Basic abc', Cookie: 'NTNX_IGW_SESSION=s' }, true);
		const received: Buffer[] = [];
		console.stream.on('data', (chunk: Buffer) => received.push(chunk));
		expect((await headers).authorization).toBe('Basic abc');
		expect((await headers).cookie).toBe('NTNX_IGW_SESSION=s');
		console.stream.write(Buffer.from('hi'));
		await expect.poll(() => Buffer.concat(received).toString()).toBe('RFB 003.008\necho:hi');
		console.dispose();
	});

	it('reports a refused upgrade as a permission problem', async () => {
		const { createServer } = await import('node:http');
		const http = createServer((_req, res) => { res.statusCode = 403; res.end(); });
		http.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
		http.listen(0, '127.0.0.1');
		await once(http, 'listening');
		try {
			await expect(openVncConsole(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/vnc`, {}, true)).rejects.toMatchObject({ code: 'permission' });
		} finally { http.close(); }
	});
});
