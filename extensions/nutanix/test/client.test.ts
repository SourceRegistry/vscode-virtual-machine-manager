import { describe, expect, it } from 'vitest';
import { errorMessage, sessionCookies, taskOf } from '../src/client';
import { done, prism } from './fake';

describe('Prism client', () => {
	it('sends basic auth to the v3 API and keeps the session cookie Prism returns', async () => {
		const { client, calls } = prism({
			'GET /users/me': () => new Response('{}', { status: 200, headers: { 'set-cookie': 'NTNX_IGW_SESSION=abc123; Path=/; Secure; HttpOnly' } }),
			'GET /versions': {}
		});
		await client.request('GET', '/users/me');
		await client.request('GET', '/versions');
		expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('admin:secret').toString('base64')}`);
		expect(calls[0]!.headers.cookie).toBeUndefined();
		expect(calls[1]!.headers.cookie).toBe('NTNX_IGW_SESSION=abc123');
		expect(client.authHeaders()).toMatchObject({ Cookie: 'NTNX_IGW_SESSION=abc123' });
	});

	it('picks only the Prism session cookies out of a combined Set-Cookie header', () => {
		const cookies = sessionCookies('other=1; Path=/, JSESSIONID=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT, NTNX_IGW_SESSION=s1; Secure');
		expect([...cookies]).toEqual([['JSESSIONID', 'xyz'], ['NTNX_IGW_SESSION', 's1']]);
	});

	it('maps HTTP errors to provider errors with the message Prism gave', async () => {
		const { client } = prism({
			'GET /a': () => new Response('{}', { status: 401 }),
			'GET /b': () => new Response(JSON.stringify({ message_list: [{ message: 'no role' }] }), { status: 403 }),
			'GET /c': () => new Response(JSON.stringify({ message_list: [{ reason: 'INVALID', message: 'spec_version stale' }] }), { status: 409 }),
			'GET /d': () => new Response('oops', { status: 500 })
		});
		await expect(client.request('GET', '/a')).rejects.toMatchObject({ code: 'permission', message: /user name or password/ });
		await expect(client.request('GET', '/b')).rejects.toMatchObject({ code: 'permission', message: /no role/ });
		await expect(client.request('GET', '/c')).rejects.toThrow(/spec_version stale/);
		await expect(client.request('GET', '/missing')).rejects.toMatchObject({ code: 'notFound' });
		await expect(client.request('GET', '/d')).rejects.toThrow('Prism answered HTTP 500');
		expect(errorMessage({ message_list: [{ reason: 'X' }] })).toBe('X');
	});

	it('explains a redirect to a web sign-in instead of reporting HTTP 302', async () => {
		const { client } = prism({ 'GET /versions': () => new Response('<html>', { status: 302, headers: { location: 'https://cloud.nutanixtestdrive.com/login?next=x' } }) });
		await expect(client.request('GET', '/versions')).rejects.toMatchObject({ code: 'unavailable', message: /redirected to https:\/\/cloud\.nutanixtestdrive\.com\. The address is behind a web sign-in/ });
	});

	it('sends a web sign-in cookie along with its own session cookie', async () => {
		const { fetch } = prism({ 'GET /a': () => new Response('{}', { status: 200, headers: { 'set-cookie': 'NTNX_IGW_SESSION=s1; Path=/' } }), 'GET /b': {} });
		const { NutanixClient } = await import('../src/client');
		const client = new NutanixClient('https://pc.test', { none: true, cookie: 'session=gw' }, fetch as unknown as typeof globalThis.fetch);
		await client.request('GET', '/a');
		await client.request('GET', '/b');
		const headers = fetch.mock.calls.map(([, init]) => Object.fromEntries(new Headers(init?.headers).entries()));
		expect(headers[0]).toMatchObject({ cookie: 'session=gw' });
		expect(headers[0]!.authorization).toBeUndefined();
		expect(headers[1]).toMatchObject({ cookie: 'session=gw; NTNX_IGW_SESSION=s1' });
	});

	it('pages through list endpoints', async () => {
		const all = Array.from({ length: 5 }, (_, i) => ({ id: i }));
		const { client, calls } = prism({ 'POST /vms/list': (body: { offset: number; length: number }) => ({ entities: all.slice(body.offset, body.offset + body.length), metadata: { total_matches: all.length } }) });
		expect(await client.listAll('/vms/list', 'vm', undefined, 2)).toEqual(all);
		expect(calls.map((c) => c.body.offset)).toEqual([0, 2, 4]);
		expect(calls[0]!.body).toMatchObject({ kind: 'vm', length: 2 });
	});

	it('finds the task of an intent and of a procedural reply', () => {
		expect(taskOf({ status: { execution_context: { task_uuid: 't1' } } })).toBe('t1');
		expect(taskOf({ status: { execution_context: { task_uuid: ['t2'] } } })).toBe('t2');
		expect(taskOf({ task_uuid: 't3' })).toBe('t3');
		expect(taskOf(undefined)).toBeUndefined();
	});

	it('waits for a task, and reports its failure or that it is still running', async () => {
		let polls = 0;
		const { client } = prism({
			'GET /tasks/ok': () => (++polls < 3 ? { status: 'RUNNING' } : done({ entity_reference_list: [{ kind: 'vm', uuid: 'x' }] })),
			'GET /tasks/bad': { status: 'FAILED', error_detail: 'Not enough memory' },
			'GET /tasks/slow': { status: 'RUNNING' }
		});
		expect(await client.waitTask('ok', 10_000, 5)).toMatchObject({ status: 'SUCCEEDED' });
		expect(polls).toBe(3);
		await expect(client.waitTask('bad')).rejects.toThrow('Nutanix task failed: Not enough memory');
		await expect(client.waitTask('slow', 30, 5)).rejects.toMatchObject({ code: 'timeout' });
		await expect(client.waitTask(undefined)).rejects.toThrow(/did not return a task/);
	});
});
