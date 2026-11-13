import type { ClusterConnection, DiskDevice, DiskImageFormat, DiskOperation } from '@vmm/sdk';
import { formatBytes } from './metrics';

/**
 * Disk sizes as people type them: `40 GB`, `512 MB`, `1.5 TB`, a plain number (GB), and `+10 GB` / `+20 MB` for
 * that much more. Binary units, as QEMU and libvirt count them (a GB is 1024³ bytes). Sizes are rounded up to whole
 * 512-byte sectors, the smallest step a disk image takes. Pure.
 */

const UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
const SECTOR = 512;
const MIN_DISK_BYTES = 1024 ** 2;
const MAX_DISK_BYTES = 64 * 1024 ** 4;

/** Bytes (whole sectors), or why the text is not a size. A leading `+` adds to `current`, which it then needs. */
export function parseDiskSize(text: string, current?: number): { bytes: number; added?: number } | { problem: string } {
	const match = /^\s*(\+)?\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*([bkmgt])?(?:i?b)?\s*$/i.exec(text);
	if (!match) return { problem: 'Type a size like 40 GB or 512 MB, or +10 GB for that much more.' };
	const [, plus, number, unit] = match;
	const amount = Number(number!.replace(',', '.')) * UNITS[(unit ?? 'g').toLowerCase()]!;
	if (plus) {
		if (current === undefined) return { problem: 'The current size is not known: type the whole size.' };
		const bytes = Math.ceil((current + amount) / SECTOR) * SECTOR;
		return { bytes, added: bytes - current };
	}
	return { bytes: Math.ceil(amount / SECTOR) * SECTOR };
}

/** Why `text` is not a usable size (`undefined` when it is). With `current`, the disk must grow. */
export function diskSizeProblem(text: string, current?: number): string | undefined {
	const parsed = parseDiskSize(text, current);
	if ('problem' in parsed) return parsed.problem;
	if (current !== undefined && parsed.bytes <= current) return `Disks can only grow: give more than ${formatBytes(current)}, or +10 GB.`;
	if (parsed.bytes < MIN_DISK_BYTES) return 'Give the disk at least 1 MB.';
	if (parsed.bytes > MAX_DISK_BYTES) return 'That is more than 64 TB.';
	return undefined;
}

/** What a typed size comes to, e.g. `32.0 GB → 42.0 GB (+10.0 GB)`; `undefined` while it is not a usable size. */
export function diskSizePreview(text: string, current?: number): string | undefined {
	if (diskSizeProblem(text, current)) return undefined;
	const parsed = parseDiskSize(text, current) as { bytes: number };
	return current === undefined ? formatBytes(parsed.bytes) : `${formatBytes(current)} → ${formatBytes(parsed.bytes)} (+${formatBytes(parsed.bytes - current)})`;
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
