import * as path from 'node:path';
import type { DiskExportOptions } from '@vmm/sdk';

/** Pure helpers for adding, converting and exporting disk images. No I/O, unit tested. */

/** The SATA controller has six ports; the CD/DVD drive takes the last (`ide.5`). */
export const MAX_SATA_DISKS = 5;
/** VirtIO disks each take a PCI slot: plenty, but not unlimited. */
export const MAX_VIRTIO_DISKS = 16;

/** `bytes` rounded up to whole 512-byte sectors: qcow2 and QMP refuse other sizes. */
export function sectors(bytes: number): number {
	return Math.ceil(bytes / 512) * 512;
}

/** The index in `VmDefinition.disks` of a `DiskDevice.id` (`disk0`, `disk1`, …), or `undefined`. */
export function diskIndex(diskId: string, count: number): number | undefined {
	const match = /^disk(\d+)$/.exec(diskId);
	if (!match) return undefined;
	const index = Number(match[1]);
	return index < count ? index : undefined;
}

/** Why another disk cannot be added, or `undefined` when it can. */
export function addDiskProblem(count: number, bus: 'virtio' | 'sata'): string | undefined {
	if (bus === 'sata' && count >= MAX_SATA_DISKS) {
		return `The SATA controller holds ${MAX_SATA_DISKS} disks. Switch the disk controller to VirtIO in the settings to add more (the guest needs VirtIO drivers).`;
	}
	if (count >= MAX_VIRTIO_DISKS) return `A machine has at most ${MAX_VIRTIO_DISKS} disks here.`;
	return undefined;
}

/** File extension for a format VM Manager writes; `diskFormat` reads the format back from it. */
export function formatExtension(format: string): string {
	switch (format) {
		case 'qcow2':
		case 'vmdk':
		case 'vhdx':
		case 'vdi':
			return format;
		default:
			return 'img';
	}
}

/** `disk<N>.<ext>` in `dir` for the first N that no existing disk uses. */
export function newDiskFile(dir: string, existing: string[], format: 'qcow2' | 'raw', join: (...parts: string[]) => string = path.join): string {
	const taken = new Set(existing.map((file) => path.basename(file).replace(/\.[^.]+$/, '').toLowerCase()));
	let n = 0;
	while (taken.has(`disk${n}`)) n++;
	return join(dir, `disk${n}.${formatExtension(format)}`);
}

/**
 * Where a converted image goes: next to the original with the new format's extension, or, for a compaction
 * (same file name), a temporary name next to it that replaces the original once complete.
 */
export function convertTarget(file: string, format: 'qcow2' | 'raw'): { temp: string; final: string } {
	const ext = path.extname(file);
	const stem = ext ? file.slice(0, -ext.length) : file;
	const final = `${stem}.${formatExtension(format)}`;
	return { temp: `${stem}.converting.${formatExtension(format)}`, final };
}

/** `qemu-img convert` arguments for an export. */
export function exportArgs(source: string, sourceFormat: string, target: string, options: DiskExportOptions): string[] {
	const extra: string[] = [];
	if (options.compress) {
		if (options.format !== 'qcow2') throw new Error('Only qcow2 copies can be compressed.');
		extra.push('-c');
	}
	// Dynamic images grow as the guest writes: the usual choice for Hyper-V and VirtualBox.
	if (options.format === 'vhdx') extra.push('-o', 'subformat=dynamic');
	if (options.format === 'vdi') extra.push('-o', 'static=off');
	return ['convert', '-f', sourceFormat, '-O', options.format, ...extra, source, target];
}

/** `qemu-img convert` arguments for an in-place conversion (or compaction). */
export function convertArgs(source: string, sourceFormat: string, target: string, format: 'qcow2' | 'raw'): string[] {
	return ['convert', '-f', sourceFormat, '-O', format, source, target];
}
