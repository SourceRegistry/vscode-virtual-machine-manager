/** Maps the PowerShell inventory/stats output to SDK types. Pure, unit tested. */
import type { DiskDevice, NicDevice, VmDetails, VmStats } from '@vmm/sdk';

export interface RawDisk {
	/** `<ControllerType>:<ControllerNumber>:<ControllerLocation>`, e.g. `SCSI:0:1`. */
	Id: string;
	Kind: 'disk' | 'cdrom';
	Path: string | null;
	SizeBytes: number | null;
	Format: string | null;
}

export interface RawNic {
	Name: string;
	Mac: string | null;
	Switch: string | null;
	Ips: string[] | string | null;
	Connected: boolean | null;
	Legacy: boolean | null;
}

export interface RawDetails {
	Generation: number;
	Disks: RawDisk[] | RawDisk | null;
	Nics: RawNic[] | RawNic | null;
}

export interface RawStats {
	CpuPercent: number | null;
	AssignedMB: number | null;
	DemandMB: number | null;
	StartupMB: number | null;
}

/** PowerShell serialises a single object as an object and an empty pipeline as null. */
export function asArray<T>(value: T[] | T | null | undefined): T[] {
	if (value === null || value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/** `00155D010203` → `00:15:5d:01:02:03` */
export function formatMac(mac: string | null | undefined): string | undefined {
	if (!mac) return undefined;
	const clean = mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
	return clean.length === 12 ? clean.replace(/(..)(?!$)/g, '$1:') : mac;
}

export function toDetails(raw: RawDetails): VmDetails {
	let disks = 0;
	let drives = 0;
	const devices: DiskDevice[] = asArray(raw.Disks).map((d) => {
		const cdrom = d.Kind === 'cdrom';
		const n = cdrom ? ++drives : ++disks;
		const bus = d.Id.split(':')[0]?.toLowerCase();
		return {
			id: d.Id,
			kind: d.Kind,
			label: cdrom ? `DVD drive ${n}` : `Hard disk ${n}`,
			path: d.Path || undefined,
			sizeBytes: d.SizeBytes ?? undefined,
			format: d.Format?.toLowerCase() || undefined,
			bus,
			readOnly: cdrom || undefined,
			removable: cdrom || undefined
		};
	});
	const nics: NicDevice[] = asArray(raw.Nics).map((n) => ({
		id: n.Name,
		label: n.Name,
		model: n.Legacy ? 'Legacy network adapter' : 'Synthetic network adapter',
		mac: formatMac(n.Mac),
		network: n.Switch || 'Not connected',
		ipAddresses: asArray(n.Ips)
			.filter((ip) => ip && !ip.toLowerCase().startsWith('fe80'))
			.sort((a, b) => Number(a.includes(':')) - Number(b.includes(':'))),
		connected: n.Connected ?? undefined
	}));
	return { disks: devices, nics, devices: [], forwards: [] };
}

export function toStats(raw: RawStats, timestamp = Date.now()): VmStats {
	const assigned = raw.AssignedMB ?? undefined;
	return {
		timestamp,
		cpuUsage: raw.CpuPercent === null || raw.CpuPercent === undefined ? undefined : Math.min(1, Math.max(0, raw.CpuPercent / 100)),
		// Demand is what the guest actually uses with dynamic memory; assigned is what it holds.
		memoryUsedMB: raw.DemandMB || assigned,
		memoryMB: assigned || raw.StartupMB || undefined
	};
}
