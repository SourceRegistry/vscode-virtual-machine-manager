import type { ClusterConnection, DiskDevice, DiskImageFormat, DiskOperation } from '@vmm/sdk';
import { formatBytes } from './metrics';

/**
 * Disk sizes in the size form: a number and a unit (MB or GB, binary as QEMU and libvirt count them: a GB is
 * 1024³ bytes). Sizes are rounded up to whole 512-byte sectors, the smallest step a disk image takes. Pure.
 */

export type SizeUnit = 'MB' | 'GB';
export const UNIT_BYTES: Record<SizeUnit, number> = { MB: 1024 ** 2, GB: 1024 ** 3 };
const SECTOR = 512;
/** The smallest disk worth making. */
export const MIN_DISK_BYTES = 1024 ** 2;
export const MAX_DISK_BYTES = 64 * 1024 ** 4;

/** MB for disks under 1 GB, else GB. */
export function defaultUnit(bytes: number | undefined): SizeUnit {
	return bytes !== undefined && bytes < UNIT_BYTES.GB ? 'MB' : 'GB';
}

/** `bytes` in `unit`, with at most three decimals (for showing and filling in). */
export function inUnit(bytes: number, unit: SizeUnit): number {
	return Math.round((bytes / UNIT_BYTES[unit]) * 1000) / 1000;
}

/** A value in `unit` as bytes, rounded up to a whole sector. */
export function sizeBytes(value: number, unit: SizeUnit): number {
	return Math.ceil((value * UNIT_BYTES[unit]) / SECTOR) * SECTOR;
}

/** The first whole number of `unit` above `bytes`: what the form suggests when growing. */
export function nextWhole(bytes: number, unit: SizeUnit): number {
	return Math.floor(bytes / UNIT_BYTES[unit] + 1e-9) + 1;
}

/** Why `value` in `unit` is not a usable size (`undefined` when it is). With `current`, the disk must grow. */
export function sizeProblem(value: number | null | undefined, unit: SizeUnit, current?: number): string | undefined {
	if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return 'Enter a size.';
	return bytesProblem(sizeBytes(value, unit), current);
}

/** Why `bytes` is not a usable size (`undefined` when it is). With `current`, the disk must grow. */
export function bytesProblem(bytes: number, current?: number): string | undefined {
	if (!Number.isFinite(bytes)) return 'Enter a size.';
	if (current !== undefined && bytes <= current) return `Disks can only grow: give more than ${formatBytes(current)}.`;
	if (bytes < MIN_DISK_BYTES) return 'Give the disk at least 1 MB.';
	if (bytes > MAX_DISK_BYTES) return 'That is more than 64 TB.';
	return undefined;
}

/** What can be done now, and what would need the VM shut down. */
export function diskOperations(connection: Pick<ClusterConnection, 'capabilities'>, running: boolean): { now: Set<DiskOperation>; needsStop: DiskOperation[] } {
	const all = connection.capabilities.diskOperations ?? [];
	const live = new Set(connection.capabilities.diskOperationsWhileRunning ?? []);
	const now = new Set(all.filter((op) => !running || live.has(op)));
	return { now, needsStop: all.filter((op) => !now.has(op)) };
}

const OPERATION_VERB: Record<DiskOperation, string> = { add: 'add', attach: 'attach', remove: 'remove', resize: 'grow', convert: 'convert', export: 'export' };

/** "Shut down vm-1 to add, convert or remove disks." */
export function needsStopText(vmName: string, ops: DiskOperation[]): string | undefined {
	// Attaching a file is a way of adding one.
	const shown = ops.includes('add') ? ops.filter((op) => op !== 'attach') : ops;
	if (!shown.length) return undefined;
	const verbs = shown.map((op) => OPERATION_VERB[op]);
	const list = verbs.length === 1 ? verbs[0] : `${verbs.slice(0, -1).join(', ')} or ${verbs[verbs.length - 1]}`;
	return `Shut down ${vmName} to ${list} disks.`;
}

/** One line about a disk: `20 GB · qcow2 · 1.3 GB on the host`. */
export function diskDescription(disk: DiskDevice): string {
	return [
		disk.sizeBytes !== undefined ? formatBytes(disk.sizeBytes) : undefined,
		disk.format,
		disk.allocatedBytes !== undefined ? `${formatBytes(disk.allocatedBytes)} on the host` : undefined
	]
		.filter(Boolean)
		.join(' · ');
}

export interface ExportChoice {
	label: string;
	description: string;
	format: DiskImageFormat;
	compress?: boolean;
	extension: string;
}

export const EXPORT_CHOICES: ExportChoice[] = [
	{ label: 'qcow2', description: 'QEMU, KVM, Proxmox, libvirt', format: 'qcow2', extension: 'qcow2' },
	{ label: 'qcow2, compressed', description: 'Smallest file; slower for a VM to run from', format: 'qcow2', compress: true, extension: 'qcow2' },
	{ label: 'raw', description: 'Plain disk image (.img), any hypervisor', format: 'raw', extension: 'img' },
	{ label: 'VMDK', description: 'VMware', format: 'vmdk', extension: 'vmdk' },
	{ label: 'VHDX', description: 'Hyper-V', format: 'vhdx', extension: 'vhdx' },
	{ label: 'VDI', description: 'VirtualBox', format: 'vdi', extension: 'vdi' }
];

/** `web-server-hard-disk-1.qcow2`: a file name from the VM and disk names. */
export function exportFileName(vmName: string, diskLabel: string, extension: string): string {
	const slug = `${vmName}-${diskLabel}`
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return `${slug || 'disk'}.${extension}`;
}
