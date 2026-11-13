import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@vmm/sdk';
import { diskDescription, diskOperations, EXPORT_CHOICES, exportFileName, growProblem, needsStopText, newDiskProblem, parseDiskSize } from '../src/shared/disks';

const GB = 1024 ** 3;

describe('disk sizes', () => {
	it('reads sizes as people type them, in binary units, GB by default', () => {
		expect(parseDiskSize('20')).toEqual({ bytes: 20 * GB });
		expect(parseDiskSize('20G')).toEqual({ bytes: 20 * GB });
		expect(parseDiskSize(' 20 GB ')).toEqual({ bytes: 20 * GB });
		expect(parseDiskSize('20GiB')).toEqual({ bytes: 20 * GB });
		expect(parseDiskSize('512 MB')).toEqual({ bytes: 512 * 1024 ** 2 });
		expect(parseDiskSize('1.5T')).toEqual({ bytes: 1.5 * 1024 * GB });
		expect(parseDiskSize('1,5 t')).toEqual({ bytes: 1.5 * 1024 * GB });
		expect(parseDiskSize('100 b')).toEqual({ bytes: 100 });
	});

	it('adds to the current size with +', () => {
		expect(parseDiskSize('+10G', 20 * GB)).toEqual({ bytes: 30 * GB });
		expect(parseDiskSize('+10G')).toHaveProperty('problem');
	});

	it('rejects what is not a size', () => {
		for (const text of ['', 'big', '-5G', '10 PB', '10 GBs']) expect(parseDiskSize(text)).toHaveProperty('problem');
	});

	it('only lets disks grow', () => {
		expect(growProblem('30G', 20 * GB)).toBeUndefined();
		expect(growProblem('+1G', 20 * GB)).toBeUndefined();
		expect(growProblem('20G', 20 * GB)).toMatch(/only grow/);
		expect(growProblem('10G', 20 * GB)).toMatch(/only grow/);
		expect(growProblem('abc', 20 * GB)).toMatch(/Write a size/);
	});

	it('bounds a new disk', () => {
		expect(newDiskProblem('20 GB')).toBeUndefined();
		expect(newDiskProblem('100 KB')).toMatch(/at least 1 MB/);
		expect(newDiskProblem('100 T')).toMatch(/64 TB/);
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
