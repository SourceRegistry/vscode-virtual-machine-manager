import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@vmm/sdk';
import { diskDescription, diskOperations, diskSizePreview, diskSizeProblem, EXPORT_CHOICES, exportFileName, needsStopText, parseDiskSize } from '../src/shared/disks';

const GB = 1024 ** 3;

describe('disk sizes', () => {
	const MB = 1024 ** 2;

	it('reads sizes as people type them, in binary units, GB by default', () => {
		expect(parseDiskSize('20')).toEqual({ bytes: 20 * GB });
		expect(parseDiskSize('20G')).toEqual({ bytes: 20 * GB });
		expect(parseDiskSize(' 20 GB ')).toEqual({ bytes: 20 * GB });
		expect(parseDiskSize('20GiB')).toEqual({ bytes: 20 * GB });
		expect(parseDiskSize('512 MB')).toEqual({ bytes: 512 * MB });
		expect(parseDiskSize('1.5T')).toEqual({ bytes: 1.5 * 1024 * GB });
		expect(parseDiskSize('1,5 tb')).toEqual({ bytes: 1.5 * 1024 * GB });
		expect(parseDiskSize('.5 GB')).toEqual({ bytes: 0.5 * GB });
	});

	it('adds to the current size with +', () => {
		expect(parseDiskSize('+10G', 20 * GB)).toEqual({ bytes: 30 * GB, added: 10 * GB });
		expect(parseDiskSize('+20MB', 20 * GB)).toEqual({ bytes: 20 * GB + 20 * MB, added: 20 * MB });
		expect(parseDiskSize('+ 1 GB', 20 * GB)).toEqual({ bytes: 21 * GB, added: GB });
		expect(parseDiskSize('+10G')).toHaveProperty('problem');
	});

	it('rounds up to whole 512-byte sectors', () => {
		expect(parseDiskSize('100 b')).toEqual({ bytes: 512 });
		expect(parseDiskSize('0.0001 MB')).toEqual({ bytes: 512 });
		expect((parseDiskSize('+1 b', 20 * GB) as { bytes: number }).bytes).toBe(20 * GB + 512);
	});

	it('rejects what is not a size', () => {
		for (const text of ['', 'big', '-5G', '10 PB', '10 GBs', '++5G']) expect(parseDiskSize(text)).toHaveProperty('problem');
	});

	it('only lets disks grow', () => {
		expect(diskSizeProblem('30G', 20 * GB)).toBeUndefined();
		expect(diskSizeProblem('+1 MB', 20 * GB)).toBeUndefined();
		expect(diskSizeProblem('20G', 20 * GB)).toMatch(/only grow: give more than 20.0 GB/);
		expect(diskSizeProblem('10G', 20 * GB)).toMatch(/only grow/);
		expect(diskSizeProblem('abc', 20 * GB)).toMatch(/Type a size/);
	});

	it('bounds a new disk', () => {
		expect(diskSizeProblem('20 GB')).toBeUndefined();
		expect(diskSizeProblem('1 MB')).toBeUndefined();
		expect(diskSizeProblem('100 KB')).toMatch(/at least 1 MB/);
		expect(diskSizeProblem('100 T')).toMatch(/64 TB/);
	});

	it('previews what a size comes to', () => {
		expect(diskSizePreview('+10 GB', 32 * GB)).toBe('32.0 GB → 42.0 GB (+10.0 GB)');
		expect(diskSizePreview('40', 32 * GB)).toBe('32.0 GB → 40.0 GB (+8.0 GB)');
		expect(diskSizePreview('512 MB')).toBe('512 MB');
		expect(diskSizePreview('10 GB', 32 * GB)).toBeUndefined();
	});
});

describe('disk operations', () => {
	const caps = { diskOperations: ['add', 'remove', 'resize', 'convert', 'export'], diskOperationsWhileRunning: ['resize'] } as Partial<Capabilities> as Capabilities;

	it('offers everything on a stopped VM and only the live operations on a running one', () => {
		expect([...diskOperations({ capabilities: caps }, false).now]).toEqual(['add', 'remove', 'resize', 'convert', 'export']);
		const running = diskOperations({ capabilities: caps }, true);
		expect([...running.now]).toEqual(['resize']);
		expect(running.needsStop).toEqual(['add', 'remove', 'convert', 'export']);
		expect(needsStopText('vm-1', running.needsStop)).toBe('Shut down vm-1 to add, remove, convert or export disks.');
		expect(needsStopText('vm-1', ['export'])).toBe('Shut down vm-1 to export disks.');
		expect(needsStopText('vm-1', [])).toBeUndefined();
		// Attaching a file is part of adding.
		expect(needsStopText('vm-1', ['add', 'attach', 'export'])).toBe('Shut down vm-1 to add or export disks.');
		expect(needsStopText('vm-1', ['attach'])).toBe('Shut down vm-1 to attach disks.');
	});

	it('describes a disk by size, format and space on the host', () => {
		expect(diskDescription({ id: 'disk0', kind: 'disk', label: 'Hard disk 1', sizeBytes: 20 * GB, format: 'qcow2', allocatedBytes: 1.5 * GB })).toBe('20.0 GB · qcow2 · 1.5 GB on the host');
		expect(diskDescription({ id: 'vda', kind: 'disk', label: 'Disk vda' })).toBe('');
	});

	it('names an export after the machine and disk', () => {
		expect(exportFileName('Web Server', 'Hard disk 1', 'vmdk')).toBe('web-server-hard-disk-1.vmdk');
		expect(exportFileName('!!!', '', 'img')).toBe('disk.img');
		expect(EXPORT_CHOICES.filter((c) => c.compress).map((c) => c.format)).toEqual(['qcow2']);
	});
});
