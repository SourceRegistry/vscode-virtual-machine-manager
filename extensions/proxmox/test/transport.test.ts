import { readFileSync } from 'node:fs';
import { Agent, createServer } from 'node:https';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { proxmoxFetch } from '../src/transport';

// Exercise the actual TLS transport with a self-signed server, never external credentials.
describe('Proxmox TLS policy', () => {
	it('honors the configured certificate verification policy', async () => {
		const server = createServer({ key: readFileSync('test/fixtures/rdp-test-key.pem'), cert: readFileSync('test/fixtures/rdp-test-cert.pem') }, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); });
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No server address');
		const agent = new Agent();
		try {
			const url = `https://127.0.0.1:${address.port}`;
			await expect(proxmoxFetch(agent, true)(url)).rejects.toThrow();
			const response = await proxmoxFetch(agent, false)(url);
			expect(await response.json()).toEqual({ data: [] });
		} finally { agent.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
	});
});
