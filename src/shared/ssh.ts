/**
 * Connecting to a VM over SSH: which address to use, and the ssh config entry that makes Remote-SSH
 * remember it. Pure, unit tested.
 */
import type { NicDevice, PortForward } from '@vmm/sdk';
import { connectAddress } from './forwards';

export interface SshTarget {
	host: string;
	port: number;
	/** A port forward on this computer, or an address the VM has on the network. */
	via: 'forward' | 'address';
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An address worth connecting to: IPv4 that is not loopback or link-local (IPv6 link-local needs a zone id). */
export function usableAddress(address: string): boolean {
	const match = IPV4.exec(address);
	if (!match) return false;
	const [a, b] = [Number(match[1]), Number(match[2])];
	return a !== 127 && a !== 0 && !(a === 169 && b === 254) && match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Where to reach the guest's SSH server: a forward to guest port 22 wins (it is exactly what the user
 * set up and works behind NAT); otherwise a network address the host can connect to directly.
 */
export function chooseSshTarget(details: { nics: NicDevice[]; forwards: PortForward[] }): SshTarget | undefined {
	const forward = details.forwards.find((f) => f.protocol === 'tcp' && f.guestPort === 22);
	if (forward) return { host: connectAddress(forward), port: forward.hostPort, via: 'forward' };
	for (const nic of details.nics) {
		if (nic.reachable === false) continue;
		const address = nic.ipAddresses?.find(usableAddress);
		if (address) return { host: address, port: 22, via: 'address' };
	}
	return undefined;
}

/** First host port from `start` that is not in `taken`. */
export function nextPort(start: number, taken: Iterable<number>): number {
	const used = new Set(taken);
	let port = start;
	while (used.has(port) && port < 65535) port++;
	return port;
}

// ---- ssh config ---------------------------------------------------------------------------------

const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const HOST = /^[A-Za-z0-9.:-]{1,253}$/;

export function validSshUser(user: string): boolean {
	return USER.test(user);
}

/** Short stable hash, to tell VMs of the same name apart in an alias. */
function shortHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
	return h.toString(16).padStart(8, '0').slice(0, 4);
}

/** `vmm-web-01-a3f2`: what `ssh` and Remote-SSH call the VM. Stable for a VM id, readable from its name. */
export function hostAlias(vmName: string, vmKey: string): string {
	const slug = vmName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'vm';
	return `vmm-${slug}-${shortHash(vmKey)}`;
}

export interface SshConfigEntry {
	alias: string;
	host: string;
	port: number;
	user: string;
	vmName: string;
}

const begin = (key: string) => `# BEGIN VM Manager: ${key}`;
const end = (key: string) => `# END VM Manager: ${key}`;

/**
 * The block for ~/.ssh/config. `HostKeyAlias` keys known_hosts by the alias instead of `127.0.0.1:2222`,
 * so two VMs forwarded on the same port at different times do not trip "host identification has changed".
 */
export function renderSshConfigBlock(key: string, entry: SshConfigEntry): string {
	if (!validSshUser(entry.user)) throw new Error(`Not a valid SSH user name: ${entry.user}`);
	if (!HOST.test(entry.host)) throw new Error(`Not a valid host: ${entry.host}`);
	if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw new Error(`Not a valid port: ${entry.port}`);
	if (!/^[A-Za-z0-9-]+$/.test(entry.alias)) throw new Error(`Not a valid alias: ${entry.alias}`);
	if (/[\r\n]/.test(key)) throw new Error('Invalid key');
	return [
		begin(key),
		`# ${entry.vmName.replace(/[\r\n]+/g, ' ')} (written by VM Manager; delete this block to forget it)`,
		`Host ${entry.alias}`,
		`  HostName ${entry.host}`,
		`  Port ${entry.port}`,
		`  User ${entry.user}`,
		`  HostKeyAlias ${entry.alias}`,
		end(key)
	].join('\n');
}

function blockRange(text: string, key: string): [number, number] | undefined {
	const start = text.indexOf(begin(key));
	if (start < 0) return undefined;
	const finish = text.indexOf(end(key), start);
	if (finish < 0) return undefined;
	return [start, finish + end(key).length];
}

/** The existing block for `key`, if any. */
export function findSshConfigBlock(text: string, key: string): string | undefined {
	const range = blockRange(text, key);
	return range ? text.slice(range[0], range[1]) : undefined;
}

/** Replaces the block for `key`, or appends it. Everything else in the file is left byte for byte. */
export function upsertSshConfigBlock(text: string, key: string, block: string): string {
	const range = blockRange(text, key);
	if (range) return text.slice(0, range[0]) + block + text.slice(range[1]);
	const separator = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
	return `${text}${separator}${block}\n`;
}

// ---- listing and removing blocks -----------------------------------------------------------------

/** What a VM Manager block in the file says, for showing it in a list. */
export interface ListedSshBlock {
	key: string;
	alias?: string;
	host?: string;
	port?: number;
	user?: string;
	/** The VM's name at the time the block was written. */
	name?: string;
}

/** Every block VM Manager wrote, in file order. A block without its end marker is not listed. */
export function listSshConfigBlocks(text: string): ListedSshBlock[] {
	const blocks: ListedSshBlock[] = [];
	for (const match of text.matchAll(/^# BEGIN VM Manager: (.+)$/gm)) {
		const key = match[1]!.trim();
		const body = findSshConfigBlock(text, key);
		if (!body || text.indexOf(body) !== match.index) continue;
		const value = (name: string) => new RegExp(`^\\s*${name}\\s+(.+?)\\s*$`, 'mi').exec(body)?.[1];
		const port = Number(value('Port'));
		blocks.push({
			key,
			alias: value('Host'),
			host: value('HostName'),
			port: Number.isInteger(port) && port > 0 ? port : undefined,
			user: value('User'),
			name: /^# (.+) \(written by VM Manager/m.exec(body)?.[1]
		});
	}
	return blocks;
}

/**
 * Removes the block for `key` and the blank line that separated it, so adding then removing gives the
 * original file back. Everything else is left byte for byte.
 */
export function removeSshConfigBlock(text: string, key: string): string {
	const range = blockRange(text, key);
	if (!range) return text;
	let before = text.slice(0, range[0]);
	let after = text.slice(range[1]);
	if (after.startsWith('\r\n')) after = after.slice(2);
	else if (after.startsWith('\n')) after = after.slice(1);
	if (before.endsWith('\n\n') && (after === '' || after.startsWith('\n'))) {
		if (after === '') before = before.slice(0, -1);
		else after = after.slice(1);
	} else if (before === '' && after.startsWith('\n')) {
		after = after.slice(1);
	}
	return before + after;
}
