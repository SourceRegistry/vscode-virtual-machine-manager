import { ProviderError } from '@vmm/sdk';
import { child, children, parseXml, textOf } from './xml';

/** What `virsh domcapabilities` says about the default emulator of the host. */
export interface HostCapabilities {
	/** `kvm`, `hvf` or `qemu` (software emulation). */
	domain: string;
	arch: string;
	machine: string;
	efi: boolean;
	hostCpu: boolean;
}

export function parseDomainCapabilities(xml: string): HostCapabilities {
	const root = parseXml(xml);
	const os = child(root, 'os');
	const firmware = children(os, 'enum').find((e) => e.attrs.name === 'firmware');
	const cpu = children(child(root, 'cpu'), 'mode').find((m) => m.attrs.name === 'host-passthrough');
	return {
		domain: textOf(root, 'domain') ?? 'qemu',
		arch: textOf(root, 'arch') ?? 'x86_64',
		machine: textOf(root, 'machine') ?? (textOf(root, 'arch') === 'aarch64' ? 'virt' : 'q35'),
		efi: os?.attrs.supported === 'yes' && !!firmware?.children.some((v) => v.text.trim() === 'efi'),
		hostCpu: cpu?.attrs.supported === 'yes'
	};
}

export const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
export const DISK_BUSES = ['virtio', 'scsi', 'sata'] as const;
export type DiskBus = (typeof DISK_BUSES)[number];

export interface NewDomain {
	name: string;
	cpus: number;
	memoryMB: number;
	/** Absolute path of the system disk. */
	diskPath: string;
	/** The disk's image format; a new volume is qcow2, a custom cloud image can be raw. */
	diskFormat?: 'qcow2' | 'raw';
	diskBus: DiskBus;
	/** Absolute path of an installer image on the libvirt host; the machine boots from it first. */
	iso?: string;
	/** Absolute path of a cloud-init `cidata` image: a CD the guest reads, never boots from. */
	seed?: string;
	uefi: boolean;
	/** `user` for QEMU's built-in networking, else the name of a libvirt network. */
	network: string;
	host: HostCapabilities;
}

const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Libvirt domain XML for a new machine, following what virt-install writes for the host's architecture. */
export function buildDomainXml(d: NewDomain): string {
	const arm = d.host.arch === 'aarch64';
	if (arm && !d.host.efi) throw new ProviderError('This host has no UEFI firmware for ARM guests (install edk2 / qemu-efi-aarch64), which they need to boot.', 'unavailable');
	if (d.diskBus === 'sata' && arm) throw new ProviderError('ARM guests have no SATA controller: use virtio or scsi.', 'invalid');
	const firmware = d.uefi || arm;
	// A CD-ROM needs an IDE, SATA, SCSI or USB bus; virtio cannot carry one. A cloud-init seed goes on
	// virtio-scsi: Debian's genericcloud kernel has no AHCI driver and would never see it on SATA.
	const cdBus = arm || d.diskBus === 'scsi' || (d.seed && !d.iso) ? 'scsi' : 'sata';
	const target = (bus: string, index: number) => `${bus === 'virtio' ? 'vd' : 'sd'}${String.fromCharCode(97 + index)}`;
	const cd = d.iso ?? d.seed;
	const needsScsi = d.diskBus === 'scsi' || (!!cd && cdBus === 'scsi');
	const lines = [
		`<domain type='${escape(d.host.domain)}'>`,
		`  <name>${escape(d.name)}</name>`,
		`  <memory unit='MiB'>${d.memoryMB}</memory>`,
		`  <vcpu>${d.cpus}</vcpu>`,
		`  <os${firmware ? " firmware='efi'" : ''}>`,
		`    <type arch='${escape(d.host.arch)}' machine='${escape(d.host.machine)}'>hvm</type>`,
		'  </os>',
		// GICv3: libvirt's default (v2) is refused by HVF, and every other emulator accepts v3.
		`  <features>${arm ? "<gic version='3'/>" : '<acpi/><apic/>'}</features>`,
		d.host.hostCpu ? "  <cpu mode='host-passthrough'/>" : '',
		"  <clock offset='utc'/>",
		'  <devices>',
		`    <disk type='file' device='disk'><driver name='qemu' type='${d.diskFormat ?? 'qcow2'}' discard='unmap'/><source file='${escape(d.diskPath)}'/><target dev='${target(d.diskBus, 0)}' bus='${d.diskBus}'/><boot order='2'/></disk>`,
		cd ? `    <disk type='file' device='cdrom'><driver name='qemu' type='raw'/><source file='${escape(cd)}'/><target dev='${target(cdBus, d.diskBus === cdBus ? 1 : 0)}' bus='${cdBus}'/><readonly/>${d.iso ? "<boot order='1'/>" : ''}</disk>` : '',
		// The ARM `virt` machine has no USB unless asked; the keyboard and tablet below need it.
		arm ? "    <controller type='usb' model='qemu-xhci'/>" : '',
		needsScsi ? "    <controller type='scsi' model='virtio-scsi'/>" : '',
		d.network === 'user'
			? "    <interface type='user'><model type='virtio'/></interface>"
			: `    <interface type='network'><source network='${escape(d.network)}'/><model type='virtio'/></interface>`,
		"    <serial type='pty'/>",
		"    <console type='pty'/>",
		"    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>",
		"    <graphics type='vnc' autoport='yes' listen='127.0.0.1'/>",
		`    <video><model type='${arm ? 'virtio' : 'vga'}'/></video>`,
		arm ? "    <input type='keyboard' bus='usb'/>\n    <input type='tablet' bus='usb'/>" : "    <input type='tablet' bus='usb'/>",
		// The statistics period makes the balloon driver report the guest's own memory use (domstats balloon.usable).
		"    <memballoon model='virtio'><stats period='5'/></memballoon>",
		'  </devices>',
		'</domain>',
		''
	];
	return lines.filter((l) => l !== '').join('\n');
}
