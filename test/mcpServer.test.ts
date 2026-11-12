import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { allowedOrigin, authorized, startMcpServer, type McpServerHandle } from '../src/extension/agent/mcpServer';
import { TOOLS, findTool, type AgentBackend } from '../src/extension/agent/tools';

const TOKEN = 'test-token-0123456789';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (response: Response): Promise<any> => response.json();

/** An MCP client round trip: initialize, list the tools, call one, over the real HTTP transport. */
describe('MCP server', () => {
	let server: McpServerHandle;
	const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
		const backend = { list: async () => [{ id: 'c/n/1', name: 'web-01', cluster: 'Local', node: 'mac', state: 'running', ipAddresses: [], favorite: false, groups: [] }] } as unknown as AgentBackend;
		if (name === 'vmm_power_vm') throw new Error('The user declined this action.');
		return JSON.stringify(await findTool(name)!.run(args, backend));
	});
	beforeAll(async () => {
		server = await startMcpServer({
			port: 0, token: TOKEN, serverInfo: { name: 'vm-manager', version: '0.0.0-test' }, instructions: 'Start with vmm_list_vms.',
			tools: () => TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.risk({}) === 'read', destructiveHint: false, openWorldHint: false } })),
			call
		});
	});
	afterAll(() => server?.close());

	const post = (body: unknown, headers: Record<string, string> = {}) =>
		fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });

	it('listens on the loopback interface', () => {
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	});

	it('initializes with the protocol version the client asked for, or the newest it knows', async () => {
		const reply = await json(await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }));
		expect(reply).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'vm-manager', version: '0.0.0-test' }, instructions: 'Start with vmm_list_vms.' } });
		const future = await json(await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }));
		expect(future.result.protocolVersion).toBe('2025-06-18');
	});

	it('accepts notifications without a reply', async () => {
		const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(response.status).toBe(202);
		expect(await response.text()).toBe('');
	});

	it('lists the tools with their schemas', async () => {
		const reply = await json(await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
		expect(reply.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
		expect(reply.result.tools[0]).toMatchObject({ name: 'vmm_list_clusters', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
	});

	it('calls a tool and returns its result as text', async () => {
		const reply = await json(await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vmm_list_vms', arguments: { state: 'running' } } }));
		expect(reply.result.isError).toBe(false);
		expect(JSON.parse(reply.result.content[0].text)).toMatchObject({ count: 1, vms: [{ name: 'web-01' }] });
		expect(call).toHaveBeenCalledWith('vmm_list_vms', { state: 'running' }, expect.any(AbortSignal));
	});

	it('reports a failed or declined call as a tool error the model can read', async () => {
		const reply = await json(await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'vmm_power_vm', arguments: { vm: 'web-01', action: 'stop' } } }));
		expect(reply.result).toEqual({ content: [{ type: 'text', text: 'The user declined this action.' }], isError: true });
	});

	it('answers unknown tools and methods with JSON-RPC errors, and ping with nothing', async () => {
		expect((await json(await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'rm_rf' } }))).error.code).toBe(-32602);
		expect((await json(await post({ jsonrpc: '2.0', id: 7, method: 'resources/list' }))).error.code).toBe(-32601);
		expect(await json(await post({ jsonrpc: '2.0', id: 8, method: 'ping' }))).toEqual({ jsonrpc: '2.0', id: 8, result: {} });
	});

	it('answers a batch with a batch', async () => {
		const reply = await json(await post([{ jsonrpc: '2.0', id: 9, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 10, method: 'ping' }]));
		expect(reply.map((r: { id: number }) => r.id)).toEqual([9, 10]);
	});

	it('refuses requests without the token, from web pages, and anything but POST /mcp', async () => {
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong' })).status).toBe(401);
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: '' })).status).toBe(401);
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(403);
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://localhost:3000' })).status).toBe(200);
		expect((await fetch(server.url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
		expect((await fetch(server.url.replace('/mcp', '/other'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
		const bad = await fetch(server.url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{nope' });
		expect(bad.status).toBe(400);
	});

	it('checks tokens and origins', () => {
		expect(authorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
		expect(authorized(`bearer  ${TOKEN} `, TOKEN)).toBe(true);
		expect(authorized(TOKEN, TOKEN)).toBe(false);
		expect(authorized(undefined, TOKEN)).toBe(false);
		expect(allowedOrigin(undefined)).toBe(true);
		expect(allowedOrigin('http://127.0.0.1:8080')).toBe(true);
		expect(allowedOrigin('https://localhost.evil.example')).toBe(false);
		expect(allowedOrigin('null')).toBe(false);
	});
});
