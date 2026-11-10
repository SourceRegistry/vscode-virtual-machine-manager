import { describe, expect, it } from 'vitest';
import { cloneDefinition } from '../src/clone';
import type { VmDefinition } from '../src/definition';

const source: VmDefinition = {
	id: 'src-id',
	name: 'web',
	arch: 'aarch64',
	cpus: 4,
	memoryMB: 4096,
	cpuModel: 'max',
	firmware: 'uefi',
	disks: ['/vms/src/disk0.qcow2', '/elsewhere/data.raw'],
	diskBus: 'virtio',
	cdrom: '/isos/debian.iso',
	nic: 'virtio-net-pci',
	mac: '52:54:00:aa:bb:cc',
	pciDevices: ['0000:01:00.0'],
	forwards: [{ protocol: 'tcp', hostPort: 2222, guestPort: 22 }],
	vga: 'std',
	serial: true,
	extraArgs: '-device virtio-rng-pci',
	notes: 'production-like',
	origin: 'imported',
	createdAt: 1
};
const clone = cloneDefinition(source, { id: 'new-id', name: 'web (clone)', disks: ['/vms/new/disk0.qcow2', '/vms/new/disk1.qcow2'], mac: '52:54:00:11:22:33', now: 99 });

describe('cloneDefinition', () => {
	it('has its own identity, disks, MAC address and creation time', () => {
		expect(clone).toMatchObject({ id: 'new-id', name: 'web (clone)', disks: ['/vms/new/disk0.qcow2', '/vms/new/disk1.qcow2'], mac: '52:54:00:11:22:33', createdAt: 99 });
	});

	it('keeps the hardware and settings of the original', () => {
		expect(clone).toMatchObject({
			arch: 'aarch64',
			cpus: 4,
			memoryMB: 4096,
			cpuModel: 'max',
			firmware: 'uefi',
			diskBus: 'virtio',
			cdrom: '/isos/debian.iso',
			nic: 'virtio-net-pci',
			vga: 'std',
			serial: true,
			extraArgs: '-device virtio-rng-pci',
			notes: 'production-like'
		});
	});

	it('leaves out what only one machine can own: port forwards, passed-through devices, the imported marker', () => {
		expect(clone).not.toHaveProperty('forwards');
		expect(clone).not.toHaveProperty('pciDevices');
		expect(clone).not.toHaveProperty('origin');
	});

	it('does not change the original', () => {
		expect(source).toMatchObject({ id: 'src-id', name: 'web', mac: '52:54:00:aa:bb:cc', origin: 'imported' });
		expect(source.forwards).toHaveLength(1);
		expect(source.disks).toEqual(['/vms/src/disk0.qcow2', '/elsewhere/data.raw']);
	});
});
