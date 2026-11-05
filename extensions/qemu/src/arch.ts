/** Guest architectures and what follows from them. Pure module, unit tested. */
import { defaultAccelerators, type DiskBus, type Firmware, type NicModel, type VgaModel } from './definition';

export type Arch = 'x86_64' | 'aarch64';
export const ARCHS: readonly Arch[] = ['x86_64', 'aarch64'];

export const ARCH_LABEL: Record<Arch, string> = {
	x86_64: 'x86-64 (Intel/AMD)',
	aarch64: 'ARM64 (aarch64)'
};

/** QEMU system emulator for the architecture. */
export function systemBinary(arch: Arch): string {
	return `qemu-system-${arch}`;
}

/** The architecture of this machine, `undefined` when QEMU has no matching guest (e.g. riscv, ppc). */
export function hostArch(nodeArch: string = process.arch): Arch | undefined {
	if (nodeArch === 'x64') return 'x86_64';
	if (nodeArch === 'arm64') return 'aarch64';
	return undefined;
}

/** VMs created before the architecture was stored are x86-64. */
export function guestArch(def: { arch?: Arch }): Arch {
	return def.arch ?? 'x86_64';
}

/** Hardware virtualisation only works for a guest of the host's own architecture. */
export function isNative(guest: Arch, host: Arch | undefined = hostArch()): boolean {
	return guest === host;
}

/** Accelerators to request: the platform's hypervisor for a native guest, TCG (emulation) otherwise. */
export function acceleratorsFor(guest: Arch, platform: NodeJS.Platform, preferred: string, host: Arch | undefined = hostArch()): string[] {
	return isNative(guest, host) ? defaultAccelerators(platform, preferred) : ['tcg'];
}

/**
 * The CPU model to pass. `max` (the default) means "as much as the accelerator offers": under a
 * hypervisor on arm64 that is the host CPU (`-cpu max` is not accepted by every HVF/KVM build).
 */
export function cpuFor(arch: Arch, model: string, accelerators: readonly string[]): string {
	const chosen = model || 'max';
	if (arch === 'aarch64' && chosen === 'max' && accelerators[0] && accelerators[0] !== 'tcg') return 'host';
	return chosen;
}

/**
 * Maps the names tools use (`qemu-system-aarch64`, libvirt `arch='aarch64'`, `arm64`, `amd64`, `i686`) to
 * an architecture this extension runs. `undefined` for anything else (ppc64, riscv64, s390x…).
 */
export function archFromName(name: string | undefined): Arch | undefined {
	const text = (name ?? '').toLowerCase().replace(/^.*qemu-system-/, '').replace(/\.exe$/, '');
	if (['x86_64', 'amd64', 'x64', 'i386', 'i686'].includes(text)) return 'x86_64';
	if (['aarch64', 'arm64'].includes(text)) return 'aarch64';
	return undefined;
}

export interface HardwareChoices {
	firmware: Firmware;
	diskBus: DiskBus;
	nic: NicModel;
	vga: VgaModel;
}

/**
 * Hardware the chosen architecture cannot have is replaced by what it does have: the ARM `virt`
 * machine has no BIOS, no IDE/SATA, no VGA, and the form's x86 defaults (e1000) make no sense there.
 */
export function normalizeHardware(arch: Arch, choices: HardwareChoices): HardwareChoices {
	if (arch !== 'aarch64') return choices;
	return {
		firmware: 'uefi',
		diskBus: 'virtio',
		nic: choices.nic === 'none' ? 'none' : choices.nic === 'e1000' || choices.nic === 'rtl8139' ? 'virtio-net-pci' : choices.nic,
		vga: 'virtio'
	};
}
