/**
 * Port forwards for domains on user-mode (NAT) networking. libvirt's own `<portForward>` needs the passt
 * backend (Linux only), so forwards are QEMU `hostfwd` rules added through the monitor
 * (`virsh qemu-monitor-command --hmp`), and kept in the domain's `<metadata>` to be added again on the
 * next start. Pure, unit tested.
 */
import { ProviderError, type PortForward } from '@vmm/sdk';

/** The namespace of VM Manager's element in a domain's `<metadata>`. */
export const METADATA_URI = 'https://sourceregistry.dev/vm-manager/forwards';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}=["']([^"']*)["']`).exec(tag)?.[1];

/** The forwards saved in `virsh metadata --uri METADATA_URI` output; empty when there are none. */
export function parseForwardsMetadata(xml: string): PortForward[] {
	return [...xml.matchAll(/<(?:\w+:)?forward\b[^>]*\/?>/g)].flatMap(([tag]) => {
		const protocol = attr(tag, 'protocol');
		const hostPort = Number(attr(tag, 'hostPort'));
		const guestPort = Number(attr(tag, 'guestPort'));
		const hostAddress = attr(tag, 'hostAddress');
		if ((protocol !== 'tcp' && protocol !== 'udp') || !validPort(hostPort) || !validPort(guestPort)) return [];
		return [{ protocol, hostPort, guestPort, ...(hostAddress && IPV4.test(hostAddress) ? { hostAddress } : {}) }];
	});
}

/** The element `virsh metadata --set` stores. */
export function forwardsMetadata(forwards: PortForward[]): string {
	const items = forwards.map((f) => `<forward protocol='${f.protocol}' hostAddress='${f.hostAddress ?? '127.0.0.1'}' hostPort='${f.hostPort}' guestPort='${f.guestPort}'/>`);
	return `<forwards>${items.join('')}</forwards>`;
}

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;

/** A forward as given by the user, with the defaults filled in; throws on anything that would reach the monitor unchecked. */
export function normalizeForward(f: PortForward): PortForward {
	if (f.protocol !== 'tcp' && f.protocol !== 'udp') throw new ProviderError('Forward TCP or UDP.', 'invalid');
	if (!validPort(f.hostPort) || !validPort(f.guestPort)) throw new ProviderError('Ports are whole numbers from 1 to 65535.', 'invalid');
	const hostAddress = f.hostAddress?.trim() || '127.0.0.1';
	if (!IPV4.test(hostAddress)) throw new ProviderError('Give the address to listen on as an IPv4 address, such as 127.0.0.1.', 'invalid');
	return { protocol: f.protocol, hostAddress, hostPort: f.hostPort, guestPort: f.guestPort };
}

/** `hostfwd_add` rule: `tcp:127.0.0.1:2222-:22`. */
export const hostfwdRule = (f: PortForward): string => `${f.protocol}:${f.hostAddress ?? '127.0.0.1'}:${f.hostPort}-:${f.guestPort}`;
/** `hostfwd_remove` rule: `tcp:127.0.0.1:2222`. */
export const hostfwdKey = (f: PortForward): string => `${f.protocol}:${f.hostAddress ?? '127.0.0.1'}:${f.hostPort}`;
export const sameHostPort = (a: PortForward, b: PortForward): boolean => a.protocol === b.protocol && a.hostPort === b.hostPort;

/** The id of the first user-mode netdev in HMP `info network` (libvirt calls it `hostnet0`). */
export function userNetdev(infoNetwork: string): string | undefined {
	return /^\s*\\\s+([\w.-]+):\s*index=\d+,type=user\b/m.exec(infoNetwork)?.[1];
}

/** The forwards QEMU has right now, from HMP `info usernet`. */
export function activeForwards(infoUsernet: string): PortForward[] {
	return [...infoUsernet.matchAll(/^\s*(TCP|UDP)\[HOST_FORWARD\]\s+\d+\s+(\S+)\s+(\d+)\s+\S+\s+(\d+)/gm)].map((m) => ({
		protocol: m[1]!.toLowerCase() as 'tcp' | 'udp',
		hostAddress: m[2] === '*' ? '0.0.0.0' : m[2]!,
		hostPort: Number(m[3]),
		guestPort: Number(m[4])
	}));
}

/** HMP answers errors as text on success; turn those into a ProviderError. */
export function checkHmp(output: string, what: string): string {
	const text = output.trim();
	if (/could not|invalid|error|not found|unknown|failed/i.test(text)) throw new ProviderError(`${what}: ${text.split('\n')[0]}`, /in use|bind/i.test(text) ? 'invalid' : 'failed');
	return output;
}
