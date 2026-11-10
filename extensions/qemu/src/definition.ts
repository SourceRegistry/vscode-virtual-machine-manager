import type { PortForward } from '@vmm/sdk';
import { hostfwdOptions } from './forwards';
import { cpuFor, guestArch, type Arch } from './arch';
import { diskFormat } from './importers';
import { vfioDeviceArgument } from './passthrough';

/** On-disk VM definition (`<vmDirectory>/<id>/vm.json`). Pure module: no I/O, unit tested. */

export type DiskBus = 'virtio' | 'sata';
export type NicModel = 'e1000' | 'virtio-net-pci' | 'rtl8139' | 'none';
export type VgaModel = 'std' | 'virtio' | 'qxl' | 'cirrus';
export type Firmware = 'bios' | 'uefi';

export interface VmDefinition {
	id: string;
	name: string;
	/** Guest architecture. Absent on VMs created before it was stored: x86-64. */
	arch?: Arch;
	cpus: number;
	memoryMB: number;
	cpuModel: string;
	firmware: Firmware;
	disks: string[];
	diskBus: DiskBus;
	cdrom?: string;
	nic: NicModel;
	/** MAC of the first NIC. Absent on VMs created before it was stored (QEMU's default then applies). */
	mac?: string;
	/** Host PCI devices (VFIO) passed through at start; the VM must be stopped to change them. */
	pciDevices?: string[];
	/** Host → guest port forwards of the user-mode NIC. */
	forwards?: PortForward[];
	vga: VgaModel;
	serial: boolean;
	extraArgs?: string;
	notes?: string;
	/** Set up by cloud-init from a seed disk (`cdrom`) when it was created: who to sign in as, for the user's reference. */
	cloudInit?: CloudInitRecord;
	/** A template: cannot be started, only cloned. */
	template?: boolean;
	/** Set when the VM was not created here: see `VmInfo.origin`. */
	origin?: 'adopted' | 'imported';
	createdAt: number;
}

/** What the seed disk was built from, kept so a clone of the machine can get its own seed. */
export interface CloudInitRecord {
	user: string;
	hostname: string;
	image?: string;
	sshKeys?: string[];
	/** SHA-512 hash, never the password. */
	passwordHash?: string;
	installAgent?: boolean;
	customUserData?: string;
}

export interface VmRuntime {
	pid: number;
	/** 0 when QMP is reached through `qmpSocket` or not at all (adopted VM without a monitor). */
	qmpPort: number;
	qmpHost?: string;
	/** Unix socket of an adopted VM's QMP monitor. */
	qmpSocket?: string;
	/** Started outside the extension (adopted): ports and sockets are the original process's. */
	external?: boolean;
	vncPort: number;
	/** Adopted VM: VNC host when not localhost, or its unix socket. */
	vncHost?: string;
	vncSocket?: string;
	serialPort?: number;
	/** Adopted VM: serial host when not localhost, its unix socket, and whether it speaks telnet. */
	serialHost?: string;
	serialSocket?: string;
	serialTelnet?: boolean;
	/** Localhost port of the guest agent channel (absent for VMs started before it existed). */
	agentPort?: number;
	startedAt: number;
}

export interface LaunchEnvironment {
	/** `-accel` values in order of preference; QEMU uses the first that initialises. */
	accelerators: string[];
	firmwareCode?: string;
	/** Per-VM copy of the UEFI variable store. */
	firmwareVars?: string;
}

/** Splits a user-supplied argument string, honouring single and double quotes. No shell involved. */
export function splitArgs(input: string | undefined): string[] {
	if (!input) return [];
	const args: string[] = [];
	let current = '';
	let quote: '"' | "'" | undefined;
	let hasToken = false;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) args.push(current);
			current = '';
			hasToken = false;
		} else {
			current += char;
			hasToken = true;
		}
	}
	if (hasToken) args.push(current);
	return args;
}

/** QEMU's option parser uses `,` as separator; a literal comma in a value is written `,,`. */
export function escapeOptionValue(value: string): string {
	return value.replace(/,/g, ',,');
}

/**
 * Drops accelerators the QEMU binary does not offer (`available`, from `-accel help`), so an x86_64
 * guest on Apple Silicon starts with plain TCG instead of failing on `hvf` first and logging a fallback.
 * TCG is always kept; an empty/unknown `available` list filters nothing.
 */
export function usableAccelerators(wanted: string[], available: string[]): string[] {
	if (!available.length) return wanted;
	const kept = wanted.filter((spec) => available.includes(spec.split(',')[0]!));
	return kept.includes('tcg') ? kept : [...kept, 'tcg'];
}

export function defaultAccelerators(platform: NodeJS.Platform, preferred = 'auto'): string[] {
	if (preferred && preferred !== 'auto') return preferred === 'tcg' ? ['tcg'] : [accelSpec(preferred), 'tcg'];
	switch (platform) {
		case 'win32':
			return [accelSpec('whpx'), 'tcg'];
		case 'linux':
			return ['kvm', 'tcg'];
		case 'darwin':
			return ['hvf', 'tcg'];
		default:
			return ['tcg'];
	}
}

function accelSpec(name: string): string {
	// WHPX needs the userspace irqchip on most QEMU builds.
	return name === 'whpx' ? 'whpx,kernel-irqchip=off' : name;
}

/** Builds the `qemu-system-<arch>` argument vector. */
export function buildArgs(def: VmDefinition, runtime: VmRuntime, env: LaunchEnvironment): string[] {
	const arch = guestArch(def);
	const arm = arch === 'aarch64';
	const args: string[] = ['-name', escapeOptionValue(def.name), '-machine', arm ? 'virt' : 'q35'];
	for (const accel of env.accelerators) args.push('-accel', accel);
	args.push('-cpu', cpuFor(arch, def.cpuModel, env.accelerators), '-smp', String(Math.max(1, def.cpus)), '-m', `${Math.max(32, def.memoryMB)}M`);

	// The ARM `virt` machine has no legacy BIOS: it always boots UEFI.
	if (def.firmware === 'uefi' || arm) {
		if (!env.firmwareCode) throw new Error(`UEFI firmware (${arm ? 'edk2 aarch64 / AAVMF' : 'OVMF / edk2'}) was not found next to QEMU`);
		args.push('-drive', `if=pflash,format=raw,readonly=on,file=${escapeOptionValue(env.firmwareCode)}`);
		if (env.firmwareVars) args.push('-drive', `if=pflash,format=raw,file=${escapeOptionValue(env.firmwareVars)}`);
	}

	def.disks.forEach((disk, index) => {
		const format = diskFormat(disk);
		args.push('-drive', `file=${escapeOptionValue(disk)},if=none,id=disk${index},format=${format}`);
		if (arm || def.diskBus === 'virtio') args.push('-device', `virtio-blk-pci,drive=disk${index},bootindex=${index + 1}`);
		else args.push('-device', `ide-hd,drive=disk${index},bus=ide.${index},bootindex=${index + 1}`);
	});

	// Always present, empty when there is no ISO: media can then be inserted at any time, also on a
	// running VM (a drive cannot be hot-added), and the guest sees the drive on its next boot.
	args.push('-drive', `${def.cdrom ? `file=${escapeOptionValue(def.cdrom)},` : ''}if=none,id=cd0,media=cdrom,readonly=on`);
	if (arm) {
		// No IDE/AHCI on `virt`: a virtio-scsi controller carries the CD (removable, so eject/insert work).
		args.push('-device', 'virtio-scsi-pci,id=scsi0');
		args.push('-device', `scsi-cd,drive=cd0,bus=scsi0.0,bootindex=${def.disks.length + 1}`);
	} else {
		// The AHCI controller of q35 has six ports (ide.0 … ide.5); the CD takes the last one.
		args.push('-device', `ide-cd,drive=cd0,bus=ide.5,bootindex=${def.disks.length + 1}`);
	}

	args.push('-nic', def.nic === 'none' ? 'none' : `user,model=${def.nic}${def.mac ? `,mac=${def.mac}` : ''}${hostfwdOptions(def.forwards)}`);
	for (const address of def.pciDevices ?? []) args.push('-device', vfioDeviceArgument(address));
	if (arm) {
		// `virt` has no VGA and no PS/2: virtio-gpu for the display, USB for keyboard and pointer.
		args.push('-device', 'virtio-gpu-pci');
		args.push('-device', 'qemu-xhci', '-device', 'usb-kbd', '-device', 'usb-tablet');
	} else {
		args.push('-vga', def.vga || 'std');
		args.push('-device', 'qemu-xhci', '-device', 'usb-tablet');
	}
	args.push('-display', 'none');
	args.push('-vnc', `127.0.0.1:${runtime.vncPort - 5900}`);
	args.push('-qmp', `tcp:127.0.0.1:${runtime.qmpPort},server=on,wait=off`);
	if (def.serial && runtime.serialPort) {
		args.push('-chardev', `socket,id=serial0,host=127.0.0.1,port=${runtime.serialPort},server=on,wait=off,telnet=off`);
		args.push('-serial', 'chardev:serial0');
	} else {
		args.push('-serial', 'none');
	}
	if (runtime.agentPort) {
		// Guest agent channel: lets the host ask a cooperative guest for a clean shutdown/reboot.
		args.push('-device', 'virtio-serial-pci');
		args.push('-chardev', `socket,id=qga0,host=127.0.0.1,port=${runtime.agentPort},server=on,wait=off,telnet=off`);
		args.push('-device', 'virtserialport,chardev=qga0,name=org.qemu.guest_agent.0');
	}
	args.push(...splitArgs(def.extraArgs));
	return args;
}
