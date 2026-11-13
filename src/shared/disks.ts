import type { ClusterConnection, DiskDevice, DiskImageFormat, DiskOperation } from '@vmm/sdk';
import { formatBytes } from './metrics';

/**
 * Disk sizes as people type them: `20`, `20G`, `20 GB`, `512 MiB`, `1.5T`, and `+10G` for "10 GB more". Binary
 * units (a GB is 1024³ bytes), as QEMU and libvirt count them. Pure.
 */

const UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/**
 * Bytes, or the reason the text is not a size. A number without a unit is in GB. A leading `+` adds to `current`
 * (and needs it).
 */
export function parseDiskSize(text: string, current?: number): { bytes: number } | { problem: string } {
	const match = /^\s*(\+)?\s*(\d+(?:[.,]\d+)?)\s*([bkmgt])?(?:i?b)?\s*$/i.exec(text);
	if (!match) return { problem: 'Write a size like 20 GB, 512 MB or +10 GB.' };
	const [, plus, number, unit] = match;
	const bytes = Math.round(Number(number!.replace(',', '.')) * UNITS[(unit ?? 'g').toLowerCase()]!);
	if (plus) {
		if (current === undefined) return { problem: 'Give the whole size: the current size is not known.' };
		return { bytes: current + bytes };
	}
	return { bytes };
}

/** Why `text` is not a usable new size for a disk of `current` bytes (`undefined` when it is). */
export function growProblem(text: string, current: number | undefined): string | undefined {
	const parsed = parseDiskSize(text, current);
	if ('problem' in parsed) return parsed.problem;
	if (current !== undefined && parsed.bytes <= current) return 'Disks can only grow: give a size larger than the current one.';
	return undefined;
}

/** Why `text` is not a usable size for a new disk (`undefined` when it is). */
export function newDiskProblem(text: string): string | undefined {
	const parsed = parseDiskSize(text);
	if ('problem' in parsed) return parsed.problem;
	if (parsed.bytes < 1024 ** 2) return 'Give the disk at least 1 MB.';
	if (parsed.bytes > 64 * 1024 ** 4) return 'That is more than 64 TB.';
	return undefined;
}

/** What can be done now, and what would need the VM shut down. */
export function diskOperations(connection: Pick<ClusterConnection, 'capabilities'>, running: boolean): { now: Set<DiskOperation>; needsStop: DiskOperation[] } {
	const all = connection.capabilities.diskOperations ?? [];
	const live = new Set(connection.capabilities.diskOperationsWhileRunning ?? []);
	const now = new Set(all.filter((op) => !running || live.has(op)));
	return { now, needsStop: all.filter((op) => !now.has(op)) };
}

const OPERATION_VERB: Record<DiskOperation, string> = { add: 'add', remove: 'remove', resize: 'grow', convert: 'convert', export: 'export' };

/** "Shut down vm-1 to add, convert or remove disks." */
export function needsStopText(vmName: string, ops: DiskOperation[]): string | undefined {
	if (!ops.length) return undefined;
	const verbs = ops.map((op) => OPERATION_VERB[op]);
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
