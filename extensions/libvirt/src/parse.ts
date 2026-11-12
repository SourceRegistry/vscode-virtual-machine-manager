import type { DiskDevice, NicDevice, Snapshot, VmState } from '@vmm/sdk';
import { child, children, parseXml, textOf, type XmlNode } from './xml';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// virsh domstats
// ---------------------------------------------------------------------------------------------

/** `virsh domstats` prints `Domain: 'name'` blocks of `key=value` lines. */
export function parseDomstats(output: string): Map<string, Record<string, string>> {
	const result = new Map<string, Record<string, string>>();
	let current: Record<string, string> | undefined;
	for (const line of output.split(/\r?\n/)) {
		const domain = /^Domain: '(.*)'$/.exec(line);
		if (domain) { current = {}; result.set(domain[1]!, current); continue; }
		const pair = /^\s+([^=\s]+)=(.*)$/.exec(line);
		if (pair && current) current[pair[1]!] = pair[2]!;
	}
	return result;
}

/** virDomainState and, for a stopped domain, the reason (5 = saved to disk). */
export function stateOf(stats: Record<string, string>): VmState {
	const state = Number(stats['state.state']);
	const reason = Number(stats['state.reason']);
	switch (state) {
		case 1: case 2: return 'running';
		case 3: case 7: return 'paused';
		case 4: return 'stopping';
		case 5: return reason === 5 ? 'saved' : 'stopped';
		default: return 'unknown';
	}
}

export interface BlockStat { name: string; readBytes: number; writeBytes: number; readOps: number; writeOps: number; readTimeNs?: number; writeTimeNs?: number; flushOps?: number; flushTimeNs?: number; capacity?: number; allocation?: number }

export function blockStats(stats: Record<string, string>): BlockStat[] {
	const count = Number(stats['block.count'] ?? 0);
	const num = (key: string): number | undefined => (stats[key] === undefined ? undefined : Number(stats[key]));
	const out: BlockStat[] = [];
	for (let i = 0; i < count; i++) {
		const name = stats[`block.${i}.name`];
		if (!name) continue;
		out.push({
			name,
			readBytes: num(`block.${i}.rd.bytes`) ?? 0, writeBytes: num(`block.${i}.wr.bytes`) ?? 0,
			readOps: num(`block.${i}.rd.reqs`) ?? 0, writeOps: num(`block.${i}.wr.reqs`) ?? 0,
			readTimeNs: num(`block.${i}.rd.times`), writeTimeNs: num(`block.${i}.wr.times`),
			flushOps: num(`block.${i}.fl.reqs`), flushTimeNs: num(`block.${i}.fl.times`),
			capacity: num(`block.${i}.capacity`), allocation: num(`block.${i}.allocation`)
		});
	}
	return out;
}

export function netStats(stats: Record<string, string>): { rxBytes: number; txBytes: number } | undefined {
	const count = Number(stats['net.count'] ?? 0);
	let found = false, rx = 0, tx = 0;
	for (let i = 0; i < count; i++) {
		if (stats[`net.${i}.rx.bytes`] === undefined) continue;
		found = true;
		rx += Number(stats[`net.${i}.rx.bytes`]);
		tx += Number(stats[`net.${i}.tx.bytes`] ?? 0);
	}
	return found ? { rxBytes: rx, txBytes: tx } : undefined;
}

// ---------------------------------------------------------------------------------------------
// virsh nodeinfo / version / domifaddr / vncdisplay
// ---------------------------------------------------------------------------------------------

export function parseColonTable(output: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of output.split(/\r?\n/)) {
		const match = /^([^:]+?):\s*(.*)$/.exec(line);
		if (match) out[match[1]!.trim()] = match[2]!.trim();
	}
	return out;
}

export interface NodeFacts { cpus?: number; memoryMB?: number; model?: string }
export function parseNodeinfo(output: string): NodeFacts {
	const info = parseColonTable(output);
	const kib = /^(\d+)\s*KiB/.exec(info['Memory size'] ?? '');
	return { ...(info['CPU(s)'] ? { cpus: Number(info['CPU(s)']) } : {}), ...(kib ? { memoryMB: Math.round(Number(kib[1]) / 1024) } : {}), ...(info['CPU model'] ? { model: info['CPU model'] } : {}) };
}

/** `Compiled against library: libvirt 12.9.0` ... `Running hypervisor: QEMU 11.1.2` */
export function parseVersion(output: string): { library?: string; hypervisor?: string } {
	const info = parseColonTable(output);
	return { library: info['Using library']?.replace(/^libvirt\s*/i, ''), hypervisor: info['Running hypervisor'] };
}

/** `virsh domifaddr`: a table of interface, MAC, protocol and address (`10.0.0.5/24`). */
export function parseDomifaddr(output: string): Array<{ mac: string; address: string }> {
	const out: Array<{ mac: string; address: string }> = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s*\S+\s+([0-9a-f:]{17})\s+(ipv4|ipv6)\s+([^\s/]+)/i.exec(line);
		if (match) out.push({ mac: match[1]!.toLowerCase(), address: match[3]! });
	}
	return out;
}

/** `virsh vncdisplay` answers `127.0.0.1:0` or `:1`: the port is 5900 plus the number. */
export function parseVncDisplay(output: string): { host: string; port: number } | undefined {
	const match = /^\s*(\[[^\]]+\]|[^:\s]*):(\d+)\s*$/m.exec(output);
	if (!match) return undefined;
	const host = match[1]!.replace(/^\[|\]$/g, '');
	return { host: host && host !== '0.0.0.0' && host !== '::' ? host : '127.0.0.1', port: 5900 + Number(match[2]) };
}

// ---------------------------------------------------------------------------------------------
// Domain XML
// ---------------------------------------------------------------------------------------------

export interface DomainSerial { kind: 'pty' | 'unix' | 'tcp'; path?: string; host?: string; port?: number }
export interface DomainGraphics { type: 'vnc' | 'spice' | 'other'; port?: number; autoport: boolean; listen?: string; socket?: string; /** Only in `dumpxml --security-info`. */ passwd?: string }
export interface DomainDisk { target: string; device: 'disk' | 'cdrom'; bus?: string; format?: string; path?: string; readOnly: boolean }
export interface DomainNic { mac?: string; model?: string; network?: string; type?: string }
export interface DomainInfo {
	name: string;
	uuid: string;
	vcpus?: number;
	memoryMB?: number;
	arch?: string;
	disks: DomainDisk[];
	nics: DomainNic[];
	graphics: DomainGraphics[];
	serial?: DomainSerial;
	agent: boolean;
}

const KIB_PER_UNIT: Record<string, number> = { b: 1 / 1024, bytes: 1 / 1024, kb: 1000 / 1024, k: 1, kib: 1, mb: 1000 * 1000 / 1024, m: 1024, mib: 1024, gb: 1000 * 1000 * 1000 / 1024, g: 1024 * 1024, gib: 1024 * 1024, tb: 1000 ** 4 / 1024, t: 1024 ** 3, tib: 1024 ** 3 };
export function memoryMB(node: XmlNode | undefined): number | undefined {
	if (!node) return undefined;
	const value = Number(node.text.trim());
	if (!Number.isFinite(value)) return undefined;
	return Math.round((value * (KIB_PER_UNIT[(node.attrs.unit ?? 'KiB').toLowerCase()] ?? 1)) / 1024);
}

export function parseDomain(xml: string): DomainInfo {
	const domain = parseXml(xml);
	if (domain.name !== 'domain') throw new Error('Not a libvirt domain definition');
	const devices = child(domain, 'devices');
	const disks = children(devices, 'disk').flatMap((disk): DomainDisk[] => {
		const target = child(disk, 'target')?.attrs.dev;
		const device = disk.attrs.device;
		if (!target || (device !== 'disk' && device !== 'cdrom')) return [];
		const source = child(disk, 'source');
		return [{ target, device, bus: child(disk, 'target')?.attrs.bus, format: child(disk, 'driver')?.attrs.type, path: source?.attrs.file ?? source?.attrs.dev ?? source?.attrs.name, readOnly: !!child(disk, 'readonly') }];
	});
	const nics = children(devices, 'interface').map((nic): DomainNic => {
		const source = child(nic, 'source');
		return { mac: child(nic, 'mac')?.attrs.address, model: child(nic, 'model')?.attrs.type, type: nic.attrs.type, network: source?.attrs.network ?? source?.attrs.bridge ?? source?.attrs.dev ?? (nic.attrs.type === 'user' ? 'user' : undefined) };
	});
	const graphics = children(devices, 'graphics').map((g): DomainGraphics => {
		const listen = children(g, 'listen')[0];
		return { type: g.attrs.type === 'vnc' || g.attrs.type === 'spice' ? g.attrs.type : 'other', ...(g.attrs.port && g.attrs.port !== '-1' ? { port: Number(g.attrs.port) } : {}), autoport: g.attrs.autoport === 'yes' || g.attrs.port === '-1', listen: g.attrs.listen ?? listen?.attrs.address, socket: g.attrs.socket ?? listen?.attrs.socket, ...(g.attrs.passwd ? { passwd: g.attrs.passwd } : {}) };
	});
	let serial: DomainSerial | undefined;
	for (const s of children(devices, 'serial')) {
		const source = child(s, 'source');
		// A pty has no path until the domain runs: libvirt picks the terminal at start.
		if (s.attrs.type === 'pty') serial = { kind: 'pty', ...(source?.attrs.path ? { path: source.attrs.path } : {}) };
		else if (s.attrs.type === 'unix' && source?.attrs.path) serial = { kind: 'unix', path: source.attrs.path };
		else if (s.attrs.type === 'tcp' && source?.attrs.service) serial = { kind: 'tcp', host: source.attrs.host || '127.0.0.1', port: Number(source.attrs.service) };
		if (serial) break;
	}
	const agent = children(devices, 'channel').some((c) => child(c, 'target')?.attrs.name === 'org.qemu.guest_agent.0');
	return {
		name: textOf(domain, 'name') ?? '',
		uuid: textOf(domain, 'uuid') ?? '',
		vcpus: Number(textOf(domain, 'vcpu')) || undefined,
		memoryMB: memoryMB(child(domain, 'memory')),
		arch: child(child(domain, 'os'), 'type')?.attrs.arch,
		disks, nics, graphics, serial, agent
	};
}

/**
 * Memory the guest itself uses, in MB: `balloon.available` (MemTotal) minus `balloon.usable` (MemAvailable),
 * both KiB. Undefined until the balloon driver reported (needs a statistics period on the domain).
 */
export function guestMemoryUsedMB(s: Record<string, string>): number | undefined {
	const available = Number(s['balloon.available']);
	const usable = Number(s['balloon.usable']);
	if (!s['balloon.available'] || !s['balloon.usable'] || !(available > 0) || !(usable >= 0) || usable > available) return undefined;
	return Math.round((available - usable) / 1024);
}

export function toDiskDevices(domain: DomainInfo, capacities: Map<string, number>): DiskDevice[] {
	return domain.disks.map((disk) => ({
		id: disk.target,
		kind: disk.device,
		label: disk.device === 'cdrom' ? `CD/DVD (${disk.target})` : `Disk ${disk.target}`,
		...(disk.path ? { path: disk.path } : {}),
		...(capacities.get(disk.target) ? { sizeBytes: capacities.get(disk.target) } : {}),
		...(disk.format && disk.device === 'disk' ? { format: disk.format } : {}),
		...(disk.bus ? { bus: disk.bus } : {}),
		readOnly: disk.readOnly,
		removable: disk.device === 'cdrom'
	}));
}

export function toNicDevices(domain: DomainInfo, addresses: Map<string, string[]>): NicDevice[] {
	return domain.nics.map((nic, index) => ({
		id: nic.mac ?? `nic${index}`,
		label: `Network adapter ${index + 1}`,
		...(nic.model ? { model: nic.model } : {}),
		...(nic.mac ? { mac: nic.mac } : {}),
		...(nic.network ? { network: nic.network } : {}),
		...(nic.mac && addresses.get(nic.mac.toLowerCase())?.length ? { ipAddresses: addresses.get(nic.mac.toLowerCase()) } : {}),
		// User-mode networking sits behind NAT: the guest is reachable through forwarded ports only.
		...(nic.type === 'user' ? { reachable: false } : {})
	}));
}

// ---------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------

/** `virsh snapshot-dumpxml`: the name, the creation time (seconds) and whether memory was saved. */
export function parseSnapshot(xml: string): Snapshot {
	const snapshot = parseXml(xml);
	const name = textOf(snapshot, 'name') ?? '';
	const created = Number(textOf(snapshot, 'creationTime'));
	const state = textOf(snapshot, 'state');
	const memory = child(snapshot, 'memory')?.attrs.snapshot;
	return {
		id: name, name,
		...(created ? { createdAt: created * 1000 } : {}),
		// A snapshot of a running or paused domain keeps its memory unless it was told not to (`memory snapshot='no'`).
		includesMemory: (state === 'running' || state === 'paused') && memory !== 'no'
	};
}
