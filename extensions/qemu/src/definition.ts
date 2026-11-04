/** On-disk VM definition (`<vmDirectory>/<id>/vm.json`). Pure module: no I/O, unit tested. */

export type DiskBus = 'virtio' | 'sata';
export type NicModel = 'e1000' | 'virtio-net-pci' | 'rtl8139' | 'none';
export type VgaModel = 'std' | 'virtio' | 'qxl' | 'cirrus';
export type Firmware = 'bios' | 'uefi';

export interface VmDefinition {
	id: string;
	name: string;
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
	vga: VgaModel;
	serial: boolean;
	extraArgs?: string;
	notes?: string;
	createdAt: number;
}

export interface VmRuntime {
	pid: number;
	qmpPort: number;
	vncPort: number;
	serialPort?: number;
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

/** Builds the qemu-system-x86_64 argument vector. */
export function buildArgs(def: VmDefinition, runtime: VmRuntime, env: LaunchEnvironment): string[] {
	const args: string[] = ['-name', escapeOptionValue(def.name), '-machine', 'q35'];
	for (const accel of env.accelerators) args.push('-accel', accel);
	args.push('-cpu', def.cpuModel || 'max', '-smp', String(Math.max(1, def.cpus)), '-m', `${Math.max(32, def.memoryMB)}M`);

	if (def.firmware === 'uefi') {
		if (!env.firmwareCode) throw new Error('UEFI firmware (OVMF / edk2) was not found next to QEMU');
		args.push('-drive', `if=pflash,format=raw,readonly=on,file=${escapeOptionValue(env.firmwareCode)}`);
		if (env.firmwareVars) args.push('-drive', `if=pflash,format=raw,file=${escapeOptionValue(env.firmwareVars)}`);
	}

	def.disks.forEach((disk, index) => {
		const format = disk.toLowerCase().endsWith('.qcow2') ? 'qcow2' : 'raw';
		args.push('-drive', `file=${escapeOptionValue(disk)},if=none,id=disk${index},format=${format}`);
		if (def.diskBus === 'virtio') args.push('-device', `virtio-blk-pci,drive=disk${index},bootindex=${index + 1}`);
		else args.push('-device', `ide-hd,drive=disk${index},bus=ide.${index},bootindex=${index + 1}`);
	});

	if (def.cdrom) {
		// The AHCI controller of q35 has six ports (ide.0 … ide.5); the CD takes the last one.
		args.push('-drive', `file=${escapeOptionValue(def.cdrom)},if=none,id=cd0,media=cdrom,readonly=on`);
		args.push('-device', `ide-cd,drive=cd0,bus=ide.5,bootindex=${def.disks.length + 1}`);
	}

	args.push('-nic', def.nic === 'none' ? 'none' : `user,model=${def.nic}${def.mac ? `,mac=${def.mac}` : ''}`);
	args.push('-vga', def.vga || 'std');
	args.push('-device', 'qemu-xhci', '-device', 'usb-tablet');
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
