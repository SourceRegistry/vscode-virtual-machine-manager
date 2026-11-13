import { describe, expect, it } from 'vitest';
import { nextTarget, parseBlkinfo, sniffFormat, targetPrefix, volumeExtension, withDisk } from '../src/disks';
import { parseDomain } from '../src/parse';

describe('libvirt disks', () => {
	it('names a new disk after the bus', () => {
		expect(targetPrefix('virtio')).toBe('vd');
		expect(targetPrefix('sata')).toBe('sd');
		expect(targetPrefix('scsi')).toBe('sd');
		expect(targetPrefix('ide')).toBe('hd');
		expect(targetPrefix(undefined)).toBe('vd');
	});

	it('takes the first free target', () => {
		expect(nextTarget([], 'virtio')).toBe('vda');
		expect(nextTarget(['vda', 'sda'], 'virtio')).toBe('vdb');
		expect(nextTarget(['sda', 'sdc'], 'sata')).toBe('sdb');
		const all = Array.from({ length: 26 }, (_, i) => `vd${String.fromCharCode(97 + i)}`);
		expect(nextTarget(all, 'virtio')).toBe('vdaa');
	});

	it('reads capacity and allocation from domblkinfo', () => {
		expect(parseBlkinfo('Capacity:       21474836480\nAllocation:     1384120320\nPhysical:       1384120320\n')).toEqual({ capacity: 21474836480, allocation: 1384120320 });
		expect(parseBlkinfo('')).toEqual({ capacity: undefined, allocation: undefined });
	});

	it('adds a disk element to the domain XML', () => {
		const xml = "<domain type='hvf'><name>a</name><devices><disk type='file' device='disk'><target dev='vda' bus='virtio'/></disk></devices></domain>";
		const domain = parseDomain(withDisk(xml, { file: "/images/a & b's.qcow2", target: 'vdb', bus: 'virtio', format: 'qcow2' }));
		expect(domain.disks.map((d) => [d.target, d.path, d.format])).toEqual([['vda', undefined, undefined], ['vdb', "/images/a & b's.qcow2", 'qcow2']]);
		expect(() => withDisk('<domain/>', { file: 'x', target: 'vdb', bus: 'virtio', format: 'raw' })).toThrow(/no devices/);
	});

	it('tells the image format from the header', () => {
		const head = (text: string) => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(512)]).subarray(0, 512);
		expect(sniffFormat(head('QFI\xfb\0\0\0\x03'))).toBe('qcow2');
		expect(sniffFormat(head('KDMV'))).toBe('vmdk');
		expect(sniffFormat(head('# Disk DescriptorFile\nversion=1'))).toBeUndefined();
		expect(sniffFormat(head('vhdxfile'))).toBe('vhdx');
		const vdi = Buffer.alloc(512);
		vdi.writeUInt32LE(0xbeda107f, 0x40);
		expect(sniffFormat(vdi)).toBe('vdi');
		expect(sniffFormat(Buffer.alloc(512), head('conectix'))).toBe('vpc');
		expect(sniffFormat(head('conectix'))).toBe('vpc');
		expect(sniffFormat(Buffer.alloc(512))).toBe('raw');
		expect(sniffFormat(Buffer.alloc(0))).toBe('raw');
		expect(['raw', 'vpc', 'qcow2'].map(volumeExtension)).toEqual(['img', 'vhd', 'qcow2']);
	});
});
