import { request, type Agent } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError } from '@vmm/sdk';

/** The Prism Central v3 ("intentful") API. Prism Element serves a subset of it under the same path. */
export const API_PATH = '/api/nutanix/v3';

/** Large VM lists are the biggest replies; anything beyond this is not a Prism answer. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** `fetch` over node:https with the TLS policy passed explicitly: VS Code's proxy layer can replace an HTTPS agent. */
export function nutanixFetch(agent: Agent, verifyTls: boolean): typeof fetch {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : input;
		const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]);
		return new Promise<Response>((resolve, reject) => {
			const req = request(url, {
				method: init?.method ?? 'GET',
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				agent, rejectUnauthorized: verifyTls, signal
			}, (res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_RESPONSE_BYTES) res.destroy(new Error('Prism response exceeds 64 MB.'));
					else chunks.push(chunk);
				});
				res.on('error', reject);
				res.on('end', () => {
					const headers = new Headers();
					for (const [key, value] of Object.entries(res.headers)) {
						if (value === undefined) continue;
						for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
					}
					const status = res.statusCode ?? 500;
					resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
				});
			});
			req.on('error', reject);
			req.end(init?.body);
		});
	};
}

/** Session cookies Prism hands out after a basic-auth request (Prism Central and Prism Element). */
const SESSION_COOKIES = ['NTNX_IGW_SESSION', 'JSESSIONID'];

/** `name=value` pairs of the Prism session cookies in a (possibly comma-joined) `Set-Cookie` header. */
export function sessionCookies(header: string | null | undefined, previous: Map<string, string> = new Map()): Map<string, string> {
	const result = new Map(previous);
	if (!header) return result;
	for (const match of header.matchAll(/(?:^|,)\s*([A-Za-z0-9_]+)=([^;,]*)/g)) {
		if (SESSION_COOKIES.includes(match[1]!)) result.set(match[1]!, match[2]!);
	}
	return result;
}

/** The first readable message of a Prism error reply (`message_list`, or a plain `message`). */
export function errorMessage(body: unknown): string | undefined {
	const reply = body as { message_list?: Array<{ message?: string; reason?: string; details?: unknown }>; message?: string; error_detail?: string } | undefined;
	const first = reply?.message_list?.find((m) => m.message || m.reason);
	return first?.message ?? first?.reason ?? reply?.error_detail ?? reply?.message;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface Reference { kind?: string; uuid: string; name?: string }

export interface Task {
	uuid?: string;
	status?: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'ABORTED' | 'SUSPENDED' | 'FAILED' | string;
	progress_message?: string;
	percentage_complete?: number;
	entity_reference_list?: Reference[];
	error_code?: string;
	error_detail?: string;
}

/** The task a mutating call started: intent replies carry it in `status.execution_context`, procedural ones at the top. */
export function taskOf(reply: unknown): string | undefined {
	const value = reply as { task_uuid?: string; status?: { execution_context?: { task_uuid?: string | string[] } } } | undefined;
	const nested = value?.status?.execution_context?.task_uuid;
	return value?.task_uuid ?? (Array.isArray(nested) ? nested[0] : nested);
}

/** A list reply of the v3 API. */
export interface ListReply<T> { entities?: T[]; metadata?: { total_matches?: number; length?: number; offset?: number } }

/**
 * How requests are signed: a Prism user and password (basic auth), or a Prism Central API key. `cookie` is
 * sent as well: the session of a web sign-in in front of Prism (Nutanix Test Drive), copied from a browser.
 */
export type Credentials = ({ username: string; password: string } | { apiKey: string } | { none: true }) & { cookie?: string };

/**
 * A signed-in Prism client. Every request carries basic auth or the API key (`X-ntnx-api-key`), plus the
 * session cookie Prism returned, so Prism does not have to check the password again on each call.
 */
export class NutanixClient {
	private cookies = new Map<string, string>();
	private readonly credentials: Record<string, string>;
	private readonly gatewayCookie?: string;
	constructor(readonly baseUrl: string, credentials: Credentials, private readonly transport: typeof fetch, private readonly signal?: AbortSignal) {
		this.credentials = 'apiKey' in credentials
			? { 'X-ntnx-api-key': credentials.apiKey }
			: 'username' in credentials ? { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}` } : {};
		this.gatewayCookie = credentials.cookie?.trim() || undefined;
	}
	/** Headers that authenticate another request to Prism (the console websocket). */
	authHeaders(): Record<string, string> {
		const cookie = [...(this.gatewayCookie ? [this.gatewayCookie] : []), ...[...this.cookies].map(([name, value]) => `${name}=${value}`)].join('; ');
		return { ...this.credentials, ...(cookie ? { Cookie: cookie } : {}) };
	}
	async request<T>(method: Method, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
		this.signal?.throwIfAborted();
		const response = await this.transport(`${this.baseUrl}${API_PATH}${path}`, {
			method,
			headers: { ...this.authHeaders(), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.any([...(this.signal ? [this.signal] : []), AbortSignal.timeout(timeoutMs)])
		});
		this.cookies = sessionCookies(response.headers.get('set-cookie'), this.cookies);
		const text = await response.text();
		let json: unknown;
		try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location') ?? '';
			let target = location;
			try { target = new URL(location, this.baseUrl).origin; } catch { /* keep as is */ }
			throw new ProviderError(`Prism did not answer: the request was redirected to ${target || 'another page'}. The address is behind a web sign-in (such as Nutanix Test Drive) or is not the Prism API; use the Prism Central address itself, usually on port 9440.`, 'unavailable');
		}
		if (!response.ok) {
			const detail = errorMessage(json);
			if (response.status === 401) {
				this.cookies.clear();
				throw new ProviderError(`Prism rejected the ${'X-ntnx-api-key' in this.credentials ? 'API key' : 'user name or password'}.`, 'permission');
			}
			if (response.status === 403) throw new ProviderError(`Prism does not allow this for the signed-in user${detail ? `: ${detail}` : '.'}`, 'permission');
			if (response.status === 404) throw new ProviderError(detail ?? `Not found in Prism (${path}).`, 'notFound');
			if (response.status === 409) throw new ProviderError(detail ?? 'Prism reports a conflicting change: the entity changed in the meantime. Refresh and try again.', 'failed');
			throw new ProviderError(`Prism answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
		}
		return json as T;
	}
	/** Every entity of a `/<kind>s/list` endpoint, page by page. */
	async listAll<T>(path: string, kind: string, filter?: string, pageSize = 250): Promise<T[]> {
		const result: T[] = [];
		for (let offset = 0; ; offset += pageSize) {
			const page = await this.request<ListReply<T>>('POST', path, { kind, offset, length: pageSize, ...(filter ? { filter } : {}) });
			const entities = page?.entities ?? [];
			result.push(...entities);
			const total = page?.metadata?.total_matches;
			if (entities.length < pageSize || (total !== undefined && result.length >= total) || offset > 100_000) return result;
		}
	}
	/** Waits for a task to finish, and returns it. Fails with the task's own error, or `timeout` when it is still running. */
	async waitTask(uuid: string | undefined, timeoutMs = 120_000, pollMs = 1000): Promise<Task> {
		if (!uuid) throw new ProviderError('Prism did not return a task for this request.');
		const deadline = Date.now() + timeoutMs;
		let wait = Math.min(250, pollMs);
		while (Date.now() < deadline) {
			const task = await this.request<Task>('GET', `/tasks/${encodeURIComponent(uuid)}`);
			if (task?.status === 'SUCCEEDED') return task;
			if (task?.status === 'FAILED' || task?.status === 'ABORTED') throw new ProviderError(`Nutanix task ${task.status === 'ABORTED' ? 'was aborted' : 'failed'}: ${task.error_detail ?? task.error_code ?? task.progress_message ?? 'unknown error'}`);
			await delay(wait, undefined, this.signal ? { signal: this.signal } : undefined);
			wait = Math.min(wait * 2, pollMs);
		}
		throw new ProviderError('The Nutanix task is still running. Check its status in Prism Central before retrying.', 'timeout');
	}
}
