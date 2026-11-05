import { request, type Agent } from 'node:https';

/** Pass TLS policy explicitly: VS Code's proxy layer can replace an HTTPS agent. */
export function proxmoxFetch(agent: Agent, verifyTls: boolean): typeof fetch {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : input;
		const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]);
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
					if (size > 16 * 1024 * 1024) res.destroy(new Error('Proxmox response exceeds 16 MB.'));
					else chunks.push(chunk);
				});
				res.on('error', reject);
				res.on('end', () => {
					const headers = new Headers();
					for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
					const status = res.statusCode ?? 500;
					resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
				});
			});
			req.on('error', reject);
			req.end(init?.body);
		});
	};
}
