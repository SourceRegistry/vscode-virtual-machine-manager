/** Pure parsers for QMP query results and host process samples. No I/O, unit tested. */
import type { DiskDevice, DiskStats, HostDevice, NicDevice } from '@vmm/sdk';

// ---- query-block ------------------------------------------------------------------------------

export interface QmpBlock {
	device: string;
	qdev?: string;
	removable?: boolean;
	tray_open?: boolean;
	inserted?: {
		ro?: boolean;
		drv?: string;
		file?: string;
		image?: { filename?: string; format?: string; 'virtual-size'?: number };
	};
}

export interface BlockContext {
	/** Bus the VM definition gives its hard disks (`sata`, `virtio`). */
	diskBus: string;
}

const DISK_ID = /^disk(\d+)$/;

/** Maps `query-block` to disks and CD/DVD drives. Block devices QEMU adds on its own (floppy, sd) are skipped. */
export function parseBlockDevices(blocks: QmpBlock[], context: BlockContext): DiskDevice[] {
	const devices: DiskDevice[] = [];
	for (const block of blocks) {
		if (!block.device || (!block.removable && !DISK_ID.test(block.device) && !block.inserted)) continue;
		if (/^(floppy|sd|ide1-cd)\d*$/.test(block.device) && !block.inserted) continue;
		const image = block.inserted?.image;
		const path = image?.filename ?? block.inserted?.file;
		if (block.removable) {
			devices.push({
				id: block.device,
				kind: 'cdrom',
				label: 'CD/DVD drive',
				path,
				sizeBytes: image?.['virtual-size'],
				format: image?.format ?? block.inserted?.drv,
				bus: 'sata',
				readOnly: true,
				removable: true
			});
		} else {
			const n = Number(DISK_ID.exec(block.device)?.[1] ?? devices.filter((d) => d.kind === 'disk').length);
			devices.push({
				id: block.device,
				kind: 'disk',
				label: `Hard disk ${n + 1}`,
				path,
				sizeBytes: image?.['virtual-size'],
				format: image?.format ?? block.inserted?.drv,
				bus: context.diskBus,
				readOnly: block.inserted?.ro ?? false
			});
		}
	}
	return devices.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id, undefined, { numeric: true }) : a.kind === 'disk' ? -1 : 1));
}

/** `qdev` (QOM path) of a removable drive: what `eject` and `blockdev-change-medium` take as `id`. */
export function removableQdev(blocks: QmpBlock[], deviceId: string): string | undefined {
	return blocks.find((b) => b.device === deviceId && b.removable)?.qdev;
}

export function hasMedia(blocks: QmpBlock[]): boolean {
	return blocks.some((b) => b.removable && !!b.inserted);
}

// ---- query-blockstats -------------------------------------------------------------------------

export interface QmpBlockStats {
	device?: string;
	stats?: Record<string, number>;
}

export function parseBlockStats(list: QmpBlockStats[]): DiskStats[] {
	const result: DiskStats[] = [];
	for (const entry of list) {
		if (!entry.device || !entry.stats) continue;
		const s = entry.stats;
		result.push({
			id: entry.device,
			readBytes: s.rd_bytes ?? 0,
			writeBytes: s.wr_bytes ?? 0,
			readOps: s.rd_operations ?? 0,
			writeOps: s.wr_operations ?? 0,
			readTimeNs: s.rd_total_time_ns,
			writeTimeNs: s.wr_total_time_ns,
			flushOps: s.flush_operations,
			flushTimeNs: s.flush_total_time_ns
		});
	}
	return result;
}

// ---- query-pci --------------------------------------------------------------------------------

export interface QmpPciBus {
	bus: number;
	devices: Array<{
		bus: number;
		slot: number;
		function: number;
		qdev_id?: string;
		class_info?: { desc?: string };
		id?: { vendor: number; device: number };
		pci_bridge?: { devices?: QmpPciBus['devices'] };
	}>;
}

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');

export function parsePciDevices(buses: QmpPciBus[]): HostDevice[] {
	const out: HostDevice[] = [];
	const walk = (devices: QmpPciBus['devices']) => {
		for (const d of devices) {
			const address = `${hex(d.bus, 2)}:${hex(d.slot, 2)}.${d.function}`;
			out.push({
				id: `pci:${address}`,
				kind: 'pci',
				label: d.class_info?.desc ?? 'PCI device',
				address,
				description: d.id ? `${hex(d.id.vendor, 4)}:${hex(d.id.device, 4)}${d.qdev_id ? ` · ${d.qdev_id}` : ''}` : d.qdev_id || undefined
			});
			if (d.pci_bridge?.devices) walk(d.pci_bridge.devices);
		}
	};
	for (const bus of buses) walk(bus.devices);
	return out;
}

// ---- guest agent: guest-network-get-interfaces ------------------------------------------------

export interface GuestInterface {
	name: string;
	'hardware-address'?: string;
	'ip-addresses'?: Array<{ 'ip-address': string; 'ip-address-type': 'ipv4' | 'ipv6'; prefix?: number }>;
}

/** IPv4 first; loopback and link-local addresses are noise. */
export function guestIpAddresses(iface: GuestInterface | undefined): string[] {
	const all = (iface?.['ip-addresses'] ?? []).map((a) => a['ip-address']).filter((ip) => !/^(127\.|169\.254\.|::1$|fe80:)/i.test(ip));
	return [...all.filter((ip) => !ip.includes(':')), ...all.filter((ip) => ip.includes(':'))];
}

export const DEFAULT_USER_NET_MAC = '52:54:00:12:34:56';

export function nicDevice(model: string, mac: string | undefined, interfaces: GuestInterface[] | undefined, running: boolean): NicDevice[] {
	if (model === 'none') return [];
	const address = (mac ?? DEFAULT_USER_NET_MAC).toLowerCase();
	const guest = interfaces?.find((i) => i['hardware-address']?.toLowerCase() === address);
	return [
		{
			id: 'nic0',
			label: 'Network adapter 1',
			model,
			mac: address,
			network: 'User networking (NAT)',
			ipAddresses: guest ? guestIpAddresses(guest) : undefined,
			connected: running
		}
	];
}

// ---- host process samples ---------------------------------------------------------------------

/**
 * CPU time as printed by `ps -o time=`: `M:SS.cc`, `H:MM:SS`, `H:MM:SS.cc` or `D-HH:MM:SS`.
 */
export function parsePsTime(text: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
	if (!match) return undefined;
	const [, d, h, m, s] = match;
	return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

export interface ProcessSample {
	cpuSeconds: number;
	rssMB: number;
}

/** `ps -o time=,rss= -p <pid>` (macOS/Linux fallback). */
export function parsePsSample(output: string): ProcessSample | undefined {
	const parts = output.trim().split(/\s+/);
	if (parts.length < 2) return undefined;
	const cpuSeconds = parsePsTime(parts[0]!);
	const rssKB = Number(parts[1]);
	if (cpuSeconds === undefined || !Number.isFinite(rssKB)) return undefined;
	return { cpuSeconds, rssMB: Math.round(rssKB / 1024) };
}

/** `/proc/<pid>/stat` utime+stime (clock ticks) and `/proc/<pid>/status` VmRSS. */
export function parseProcStat(stat: string, status: string, ticksPerSecond = 100): ProcessSample | undefined {
	// The command name (field 2) may contain spaces and parentheses: split after the last ')'.
	const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
	const utime = Number(rest[11]);
	const stime = Number(rest[12]);
	const rss = /VmRSS:\s+(\d+)\s*kB/.exec(status);
	if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
	return { cpuSeconds: (utime + stime) / ticksPerSecond, rssMB: rss ? Math.round(Number(rss[1]) / 1024) : 0 };
}

/**
 * CPU usage between two samples as a fraction of `cpus` vCPUs, clamped to 0..1. QEMU's own I/O and
 * emulation threads can push the process above its vCPU count, hence the clamp.
 */
export function cpuUsageBetween(previous: { at: number; cpuSeconds: number } | undefined, current: { at: number; cpuSeconds: number }, cpus: number): number | undefined {
	if (!previous) return undefined;
	const wall = (current.at - previous.at) / 1000;
	if (wall <= 0) return undefined;
	const used = (current.cpuSeconds - previous.cpuSeconds) / wall / Math.max(1, cpus);
	return Math.min(1, Math.max(0, used));
}

export interface CpuSample {
	at: number;
	cpuSeconds: number;
	/** The usage last derived from this baseline. */
	usage?: number;
}

/**
 * Next baseline and usage for a polled process. Calls closer than `minIntervalMs` to the baseline
 * (two dashboards polling the same VM) reuse the last answer instead of re-measuring over a tiny
 * window, which would make the numbers jumpy.
 */
export function nextCpuSample(
	previous: CpuSample | undefined,
	current: { at: number; cpuSeconds: number },
	cpus: number,
	minIntervalMs = 1000
): { sample: CpuSample; usage: number | undefined } {
	if (previous && current.at - previous.at < minIntervalMs) return { sample: previous, usage: previous.usage };
	const usage = cpuUsageBetween(previous, current, cpus);
	return { sample: { ...current, usage }, usage };
}
