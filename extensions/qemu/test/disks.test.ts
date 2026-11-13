import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDiskProblem, attachProblem, convertArgs, convertTarget, diskIndex, exportArgs, formatExtension, MAX_SATA_DISKS, newDiskFile, sectors } from '../src/disks';
import { diskFormat } from '../src/importers';

describe('disk helpers', () => {
	it('maps disk ids to definition indexes', () => {
		expect(diskIndex('disk0', 2)).toBe(0);
		expect(diskIndex('disk1', 2)).toBe(1);
		expect(diskIndex('disk2', 2)).toBeUndefined();
		expect(diskIndex('cd0', 2)).toBeUndefined();
		expect(diskIndex('disk', 2)).toBeUndefined();
	});

	it('rounds sizes up to whole sectors', () => {
		expect(sectors(1024 ** 2)).toBe(1024 ** 2);
		expect(sectors(1)).toBe(512);
		expect(sectors(1025)).toBe(1536);
	});

	it('limits SATA to the ports the CD/DVD drive leaves', () => {
		expect(addDiskProblem(MAX_SATA_DISKS - 1, 'sata')).toBeUndefined();
		expect(addDiskProblem(MAX_SATA_DISKS, 'sata')).toMatch(/VirtIO/);
		expect(addDiskProblem(MAX_SATA_DISKS, 'virtio')).toBeUndefined();
		expect(addDiskProblem(16, 'virtio')).toMatch(/at most 16/);
	});

	it('names a new disk after the first free number', () => {
		const dir = '/vms/a';
		expect(newDiskFile(dir, [], 'qcow2', path.posix.join)).toBe('/vms/a/disk0.qcow2');
		expect(newDiskFile(dir, ['/vms/a/disk0.qcow2', '/vms/a/disk2.img'], 'raw', path.posix.join)).toBe('/vms/a/disk1.img');
		// Another extension of the same number is taken too.
		expect(newDiskFile(dir, ['/vms/a/disk0.img'], 'qcow2', path.posix.join)).toBe('/vms/a/disk1.qcow2');
	});

	it('writes extensions the format is read back from', () => {
		for (const format of ['qcow2', 'raw', 'vmdk', 'vhdx', 'vdi']) {
			expect(diskFormat(`x.${formatExtension(format)}`)).toBe(format);
		}
	});

	it('converts next to the original, compacting through a temporary file', () => {
		expect(convertTarget('/vms/a/disk0.qcow2', 'raw')).toEqual({ temp: '/vms/a/disk0.converting.img', final: '/vms/a/disk0.img' });
		expect(convertTarget('/vms/a/disk0.qcow2', 'qcow2')).toEqual({ temp: '/vms/a/disk0.converting.qcow2', final: '/vms/a/disk0.qcow2' });
		expect(convertTarget('/vms/a/disk', 'qcow2').final).toBe('/vms/a/disk.qcow2');
		expect(convertArgs('/a.img', 'raw', '/a.converting.qcow2', 'qcow2')).toEqual(['convert', '-f', 'raw', '-O', 'qcow2', '/a.img', '/a.converting.qcow2']);
	});

	it('exports to every format, compressing qcow2 only', () => {
		expect(exportArgs('/a.qcow2', 'qcow2', '/out.qcow2', { format: 'qcow2', compress: true })).toEqual(['convert', '-f', 'qcow2', '-O', 'qcow2', '-c', '/a.qcow2', '/out.qcow2']);
		expect(exportArgs('/a.qcow2', 'qcow2', '/out.vhdx', { format: 'vhdx' })).toEqual(['convert', '-f', 'qcow2', '-O', 'vhdx', '-o', 'subformat=dynamic', '/a.qcow2', '/out.vhdx']);
		expect(exportArgs('/a.qcow2', 'qcow2', '/out.vmdk', { format: 'vmdk' })).toEqual(['convert', '-f', 'qcow2', '-O', 'vmdk', '/a.qcow2', '/out.vmdk']);
		expect(() => exportArgs('/a.qcow2', 'qcow2', '/out.img', { format: 'raw', compress: true })).toThrow(/qcow2/);
	});

	it('uses an image in place only when that is safe', () => {
		const ok = { format: 'qcow2', named: 'qcow2', users: [], snapshots: 0 };
		expect(attachProblem(ok)).toBeUndefined();
		expect(attachProblem({ ...ok, users: ['web'] })).toMatch(/already a disk of web/);
		expect(attachProblem({ ...ok, named: 'raw' })).toMatch(/file name says raw, but the image is qcow2/);
		expect(attachProblem({ ...ok, snapshots: 2 })).toMatch(/snapshots/);
	});
});
