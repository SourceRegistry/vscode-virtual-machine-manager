import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDomainXml, parseDomainCapabilities, type HostCapabilities } from '../src/definition';
import { parseXml } from '../src/xml';

const arm: HostCapabilities = { domain: 'hvf', arch: 'aarch64', machine: 'virt-11.1', efi: true, hostCpu: true };
const x86: HostCapabilities = { domain: 'kvm', arch: 'x86_64', machine: 'pc-q35-9.0', efi: true, hostCpu: true };
const base = { name: 'web', cpus: 2, memoryMB: 1024, diskPath: '/pool/web.qcow2', diskBus: 'virtio' as const, uefi: false, network: 'user' };

describe('parseDomainCapabilities', () => {
	it('reads the emulator of the host', () => {
		expect(parseDomainCapabilities(readFileSync(new URL('./fixtures/domcapabilities.xml', import.meta.url), 'utf8'))).toEqual({ domain: 'hvf', arch: 'aarch64', machine: 'virt-11.1', efi: true, hostCpu: true });
	});
});

describe('buildDomainXml', () => {
	it('builds an ARM guest with UEFI, GICv3 and a SCSI CD-ROM', () => {
		const xml = buildDomainXml({ ...base, iso: '/isos/a.iso', host: arm });
		expect(() => parseXml(xml)).not.toThrow();
		expect(xml).toContain("<domain type='hvf'>");
		expect(xml).toContain("<os firmware='efi'>");
		expect(xml).toContain("<gic version='3'/>");
		expect(xml).toContain("<target dev='vda' bus='virtio'/>");
		expect(xml).toContain("<target dev='sda' bus='scsi'/>");
		expect(xml).toContain("<controller type='scsi' model='virtio-scsi'/>");
		expect(xml).toContain("<controller type='usb' model='qemu-xhci'/>");
	});
	it('builds an x86 guest on BIOS with a SATA CD-ROM', () => {
		const xml = buildDomainXml({ ...base, iso: '/isos/a.iso', host: x86 });
		expect(xml).not.toContain('firmware=');
		expect(xml).toContain('<acpi/><apic/>');
		expect(xml).toContain("<target dev='sda' bus='sata'/>");
		expect(xml).not.toContain('controller');
	});
	it('puts the system disk and the CD-ROM on different device names when they share a bus', () => {
		const xml = buildDomainXml({ ...base, diskBus: 'sata', iso: '/a.iso', host: x86 });
		expect(xml).toContain("<target dev='sda' bus='sata'/><boot order='2'/>");
		expect(xml).toContain("<target dev='sdb' bus='sata'/>");
	});
	it('escapes names and paths, and uses a libvirt network when given', () => {
		const xml = buildDomainXml({ ...base, network: 'br&0', iso: "/it's <a>.iso", host: x86 });
		expect(() => parseXml(xml)).not.toThrow();
		expect(xml).toContain("<source network='br&amp;0'/>");
		expect(xml).toContain('/it&apos;s &lt;a&gt;.iso');
	});
	it('refuses what the host cannot boot', () => {
		expect(() => buildDomainXml({ ...base, host: { ...arm, efi: false } })).toThrow(/UEFI/);
		expect(() => buildDomainXml({ ...base, diskBus: 'sata', host: arm })).toThrow(/SATA/);
	});
});
