import { Client, TerminalSession } from 'pve-client';
import WebSocket from 'ws';
import { ProviderError } from '@vmm/sdk';

/** pve-client's Terminal helper requires a cookie; use its protocol session with token auth. */
export function tokenTerminal(client: Client, node: string, vmid: number, verifyTls: boolean, type: 'qemu' | 'lxc' = 'qemu', serial: 'serial0' | 'serial1' | 'serial2' | 'serial3' = 'serial0'): TerminalSession {
	return new TerminalSession(async () => {
		const ticket = type === 'qemu'
			? await client.request('/nodes/{node}/qemu/{vmid}/termproxy', 'POST', { $path: { node, vmid }, $body: { serial } })
			: await client.request('/nodes/{node}/lxc/{vmid}/termproxy', 'POST', { $path: { node, vmid } });
		const url = new URL(client.url(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/vncwebsocket`, { port: ticket.port, vncticket: ticket.ticket }));
		url.protocol = 'wss:';
		const authorization = client.tokenAuthorizationHeader();
		const cookie = client.sessionCookie();
		if (!authorization && !cookie) throw new ProviderError('Not signed in to Proxmox.', 'permission');
		return {
			info: { node, vmid, type, ticket, websocketUrl: url.toString(), authMessage: `${ticket.user}:${ticket.ticket}\n` },
			socket: new WebSocket(url, { headers: { ...(authorization ? { Authorization: authorization } : { Cookie: cookie! }), Origin: `https://${url.host}` }, rejectUnauthorized: verifyTls, handshakeTimeout: 30_000 })
		};
	}, { reconnect: false, reconnectIntervalMs: 1500, reconnectMaxAttempts: 0 });
}
