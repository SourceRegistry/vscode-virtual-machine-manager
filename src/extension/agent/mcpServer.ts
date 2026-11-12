/**
 * A Model Context Protocol server for agents outside VS Code (Claude Code, other MCP clients), over the
 * Streamable HTTP transport: JSON-RPC in a POST to `/mcp`, answered with plain JSON (no server-sent events,
 * no sessions: every request stands on its own). It listens on the loopback interface only, needs a bearer
 * token, and refuses requests from web pages (an `Origin` that is not localhost), against DNS rebinding.
 * What a tool does, and asking the user first, is the caller's business (`call`). No `vscode` import here.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InputSchema } from './tools';

/** Newest first. A client asking for another version gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpToolInfo {
	name: string;
	title: string;
	description: string;
	inputSchema: InputSchema;
	annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

export interface McpServerOptions {
	host?: string;
	/** 0 picks a free port. */
	port: number;
	token: string;
	serverInfo: { name: string; version: string };
	instructions?: string;
	tools(): McpToolInfo[];
	/** Runs a tool: its text, or text and PNG images. A rejection becomes an error result the model can read (`isError`). */
	call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string | McpToolResult>;
	log?(line: string): void;
}

export interface McpToolResult {
	text: string;
	images?: Array<{ mimeType: string; data: Buffer }>;
}

export interface McpServerHandle {
	port: number;
	url: string;
	close(): Promise<void>;
}

type JsonRpcId = string | number | null;
interface JsonRpcMessage { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> }

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Whether the request carries the token, compared in constant time. */
export function authorized(header: string | undefined, token: string): boolean {
	const given = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim();
	return !!given && timingSafeEqual(digest(given), digest(token));
}

/** Requests from a browser page carry an Origin; only a local one is accepted. Non-browser clients send none. */
export function allowedOrigin(origin: string | undefined): boolean {
	if (!origin) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || origin.startsWith('vscode-webview://') || origin.startsWith('vscode-file://');
	} catch {
		return false;
	}
}

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function startMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
	const host = options.host ?? '127.0.0.1';
	const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
		res.writeHead(status, { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers });
		res.end(body === undefined ? undefined : JSON.stringify(body));
	};

	async function handle(message: JsonRpcMessage, signal: AbortSignal): Promise<object | undefined> {
		const id = message.id ?? null;
		// A notification (no id) or a response to us: nothing to answer.
		if (message.id === undefined || !message.method) return undefined;
		switch (message.method) {
			case 'initialize': {
				const asked = String(message.params?.protocolVersion ?? '');
				return {
					jsonrpc: '2.0', id,
					result: {
						protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
						capabilities: { tools: { listChanged: false } },
						serverInfo: options.serverInfo,
						...(options.instructions ? { instructions: options.instructions } : {})
					}
				};
			}
			case 'ping':
				return { jsonrpc: '2.0', id, result: {} };
			case 'tools/list':
				return { jsonrpc: '2.0', id, result: { tools: options.tools() } };
			case 'tools/call': {
				const name = String(message.params?.name ?? '');
				if (!options.tools().some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
				const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
				try {
					const answer = await options.call(name, args, signal);
					const { text, images = [] } = typeof answer === 'string' ? { text: answer } : answer;
					const content = [{ type: 'text', text }, ...images.map((image) => ({ type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType }))];
					return { jsonrpc: '2.0', id, result: { content, isError: false } };
				} catch (error) {
					return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } };
				}
			}
			default:
				return rpcError(id, -32601, `Method not found: ${message.method}`);
		}
	}

	const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const path = (req.url ?? '/').split('?')[0];
		if (!allowedOrigin(req.headers.origin)) return send(res, 403, rpcError(null, -32000, 'Origin not allowed.'));
		if (path !== '/mcp') return send(res, 404, rpcError(null, -32000, 'Not found. The MCP endpoint is /mcp.'));
		if (!authorized(req.headers.authorization, options.token)) return send(res, 401, rpcError(null, -32001, 'Missing or wrong bearer token. Run "VM: Copy MCP Server Setup" in VS Code.'), { 'WWW-Authenticate': 'Bearer' });
		if (req.method === 'DELETE') return send(res, 405, undefined, { Allow: 'POST' });
		// No server-initiated stream: the server never sends requests or notifications of its own.
		if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST' });

		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) return send(res, 413, rpcError(null, -32600, 'Request too large.'));
			chunks.push(chunk as Buffer);
		}
		let body: unknown;
		try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, rpcError(null, -32700, 'Parse error.')); }

		// The client going away aborts a waiting tool (a confirmation, a long command).
		const abort = new AbortController();
		res.on('close', () => { if (!res.writableFinished) abort.abort(); });
		const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
		if (messages.some((m) => typeof m !== 'object' || m === null)) return send(res, 400, rpcError(null, -32600, 'Invalid request.'));
		for (const m of messages) if (m.method) options.log?.(`${m.method}${m.method === 'tools/call' ? ` ${String(m.params?.name ?? '')}` : ''}`);
		const replies = (await Promise.all(messages.map((m) => handle(m, abort.signal)))).filter((r): r is object => r !== undefined);
		if (!replies.length) return send(res, 202);
		send(res, 200, Array.isArray(body) ? replies : replies[0]);
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, host, () => { server.off('error', reject); resolve(); });
	});
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		url: `http://${host}:${port}/mcp`,
		close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
	};
}
