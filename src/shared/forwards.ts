/** What a user can do with a port forward from the host. Pure, unit tested. */
import type { PortForward } from '@vmm/sdk';

/** Where a guest on QEMU user-mode networking reaches the host. */
export const GUEST_HOST_ADDRESS = '10.0.2.2';

/** Address a client on the host connects to. */
export function connectAddress(forward: PortForward): string {
	const host = forward.hostAddress || '127.0.0.1';
	return host === '0.0.0.0' ? '127.0.0.1' : host;
}

/** `ssh -p 2222 127.0.0.1` for a forward to guest port 22; the user name is the caller's to add. */
export function sshCommand(forward: PortForward): string | undefined {
	if (forward.protocol !== 'tcp' || forward.guestPort !== 22) return undefined;
	return `ssh -p ${forward.hostPort} ${connectAddress(forward)}`;
}

const HTTPS_PORTS = new Set([443, 8443]);
const HTTP_PORTS = new Set([80, 3000, 5000, 8000, 8080, 8888, 9090]);

/** URL to open for a forward to a web port, otherwise `undefined`. */
export function browserUrl(forward: PortForward): string | undefined {
	if (forward.protocol !== 'tcp') return undefined;
	const scheme = HTTPS_PORTS.has(forward.guestPort) ? 'https' : HTTP_PORTS.has(forward.guestPort) ? 'http' : undefined;
	return scheme ? `${scheme}://${connectAddress(forward)}:${forward.hostPort}/` : undefined;
}
