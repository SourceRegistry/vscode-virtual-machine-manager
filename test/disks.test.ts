import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@vmm/sdk';
import { bytesProblem, defaultUnit, diskDescription, diskOperations, EXPORT_CHOICES, exportFileName, inUnit, needsStopText, nextWhole, sizeBytes, sizeProblem } from '../src/shared/disks';

const GB = 1024 ** 3;

describe('disk sizes', () => {
	const MB = 1024 ** 2;

	it('uses MB for disks under 1 GB', () => {
		expect(defaultUnit(64 * MB)).toBe('MB');
		expect(defaultUnit(GB)).toBe('GB');
		expect(defaultUnit(undefined)).toBe('GB');
	});

	it('converts between units and rounds up to whole 512-byte sectors', () => {
		expect(sizeBytes(20, 'GB')).toBe(20 * GB);
		expect(sizeBytes(1.5, 'GB')).toBe(1.5 * GB);
		expect(sizeBytes(64, 'MB')).toBe(64 * MB);
		expect(sizeBytes(0.0001, 'MB') % 512).toBe(0);
		expect(sizeBytes(0.0001, 'MB')).toBe(512);
		expect(inUnit(21 * GB, 'MB')).toBe(21504);
		expect(inUnit(1.5 * GB, 'GB')).toBe(1.5);
	});

	it('suggests the next whole unit when growing', () => {
		expect(nextWhole(20 * GB, 'GB')).toBe(21);
		expect(nextWhole(20.4 * GB, 'GB')).toBe(21);
		expect(nextWhole(64 * MB, 'MB')).toBe(65);
	});

	it('only lets disks grow, by as little as a sector', () => {
		expect(sizeProblem(21, 'GB', 20 * GB)).toBeUndefined();
		expect(sizeProblem(20 * 1024 + 1, 'MB', 20 * GB)).toBeUndefined();
		expect(sizeProblem(20, 'GB', 20 * GB)).toMatch(/only grow: give more than 20.0 GB/);
		expect(sizeProblem(10, 'GB', 20 * GB)).toMatch(/only grow/);
		expect(bytesProblem(20 * GB + 512, 20 * GB)).toBeUndefined();
	});

	it('bounds a size', () => {
		expect(sizeProblem(20, 'GB')).toBeUndefined();
		expect(sizeProblem(1, 'MB')).toBeUndefined();
		expect(sizeProblem(0.5, 'MB')).toMatch(/at least 1 MB/);
		expect(sizeProblem(70_000, 'GB')).toMatch(/64 TB/);
		for (const value of [null, undefined, Number.NaN, 0, -5]) expect(sizeProblem(value, 'GB')).toBe('Enter a size.');
		expect(bytesProblem(Number.NaN)).toBe('Enter a size.');
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
