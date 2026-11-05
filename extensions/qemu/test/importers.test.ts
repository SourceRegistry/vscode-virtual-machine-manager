import { describe, expect, it } from 'vitest';
import { candidatesFromFolder, classifyFile, diskFormat, parseLibvirtXml } from '../src/importers';

const XML = `<domain type='kvm'>
  <name>web &amp; db</name>
  <memory unit='KiB'>2097152</memory>
  <currentMemory unit='KiB'>1048576</currentMemory>
  <vcpu placement='static'>4</vcpu>
  <os firmware='efi'><type arch='x86_64'>hvm</type></os>
  <devices>
    <disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='/var/lib/libvirt/images/web.qcow2'/><target dev='vda'/></disk>
    <disk type='file' device='cdrom'><source file="/isos/debian.iso"/><target dev='sda'/></disk>
    <disk type='file' device='cdrom'><target dev='sdb'/></disk>
  </devices>
</domain>`;

describe('diskFormat / classifyFile', () => {
	it('maps extensions to QEMU formats', () => {
		expect(diskFormat('/a/x.qcow2')).toBe('qcow2');
		expect(diskFormat('/a/X.VMDK')).toBe('vmdk');
		expect(diskFormat('/a/x.vhd')).toBe('vpc');
		expect(diskFormat('/a/x.img')).toBe('raw');
	});
	it('classifies disks and ISOs only', () => {
		expect(classifyFile('/a/x.vdi')).toBe('disk');
		expect(classifyFile('/a/x.ISO')).toBe('iso');
		expect(classifyFile('/a/readme.txt')).toBeUndefined();
	});
});

describe('parseLibvirtXml', () => {
	it('reads name, configured memory, vcpus, disks, cdrom and firmware', () => {
		expect(parseLibvirtXml(XML)).toEqual({ name: 'web & db', memoryMB: 2048, cpus: 4, disks: ['/var/lib/libvirt/images/web.qcow2'], cdrom: '/isos/debian.iso', uefi: true });
	});
	it('converts units', () => {
		expect(parseLibvirtXml("<domain><name>a</name><memory unit='GiB'>2</memory></domain>")?.memoryMB).toBe(2048);
		expect(parseLibvirtXml('<domain><name>a</name><memory>524288</memory></domain>')?.memoryMB).toBe(512);
	});
	it('falls back to currentMemory', () => {
		expect(parseLibvirtXml("<domain><name>a</name><currentMemory unit='MiB'>768</currentMemory></domain>")?.memoryMB).toBe(768);
	});
	it('rejects other XML', () => {
		expect(parseLibvirtXml('<network><name>x</name></network>')).toBeUndefined();
	});
});

describe('candidatesFromFolder', () => {
	it('prefers definitions over loose images and resolves relative paths', () => {
		const result = candidatesFromFolder({
			files: ['/lib/web.qcow2', '/lib/old.vmdk', '/lib/boot.iso', '/lib/a/disk0.qcow2'],
			libvirt: new Map([['/lib/web.xml', XML.replace('/var/lib/libvirt/images/web.qcow2', '/lib/web.qcow2')]]),
			vmJson: new Map([['/lib/a/vm.json', { name: 'alpha', disks: ['disk0.qcow2'], cpus: 2, memoryMB: 512, firmware: 'uefi' }]])
		});
		expect(result.map((c) => [c.name, c.source])).toEqual([
			['alpha', 'vm.json'],
			['web & db', 'libvirt'],
			['old', 'image']
		]);
		expect(result[0]).toMatchObject({ disks: ['/lib/a/disk0.qcow2'], uefi: true });
		// the single ISO beside the loose image becomes its CD
		expect(result[2]).toMatchObject({ disks: ['/lib/old.vmdk'], cdrom: '/lib/boot.iso' });
	});

	it('names UTM bundles after the bundle and skips ambiguous ISOs', () => {
		const result = candidatesFromFolder({
			files: ['/vms/Win11.utm/Data/disk.qcow2', '/vms/Win11.utm/Data/a.iso', '/vms/Win11.utm/Data/b.iso'],
			libvirt: new Map(),
			vmJson: new Map()
		});
		expect(result).toEqual([{ id: '/vms/Win11.utm/Data/disk.qcow2', name: 'Win11', source: 'utm', disks: ['/vms/Win11.utm/Data/disk.qcow2'], cdrom: undefined }]);
	});

	it('is empty for a folder without VMs', () => {
		expect(candidatesFromFolder({ files: ['/x/readme.txt'], libvirt: new Map(), vmJson: new Map() })).toEqual([]);
	});
});
