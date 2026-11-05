import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceleratorsFor, archFromName, cpuFor, guestArch, hostArch, isNative, normalizeHardware, systemBinary } from '../src/arch';
import { buildArgs, usableAccelerators, type VmDefinition } from '../src/definition';
import { findFirmware } from '../src/detect';

const base: VmDefinition = {
	id: '00000000-0000-0000-0000-000000000000',
	name: 'arm',
	arch: 'aarch64',
	cpus: 4,
	memoryMB: 4096,
	cpuModel: 'max',
	firmware: 'uefi',
	disks: ['/vms/a/disk0.qcow2'],
	diskBus: 'virtio',
	cdrom: '/isos/debian-arm64.iso',
	nic: 'virtio-net-pci',
	mac: '52:54:00:aa:bb:cc',
	vga: 'virtio',
	serial: true,
	createdAt: 0
};
const runtime = { pid: 1, qmpPort: 4444, vncPort: 5901, serialPort: 4445, agentPort: 4446, startedAt: 0 };
const env = { accelerators: ['hvf', 'tcg'], firmwareCode: '/fw/edk2-aarch64-code.fd', firmwareVars: '/vms/a/efivars.fd' };

const pairs = (args: string[]) => args.flatMap((a, i) => (a.startsWith('-') ? [`${a} ${args[i + 1] ?? ''}`.trim()] : []));

describe('host and guest architecture', () => {
	it('maps Node architectures and names', () => {
		expect(hostArch('arm64')).toBe('aarch64');
		expect(hostArch('x64')).toBe('x86_64');
		expect(hostArch('riscv64')).toBeUndefined();
		expect(archFromName('/opt/homebrew/bin/qemu-system-aarch64')).toBe('aarch64');
		expect(archFromName('C:\\qemu\\qemu-system-x86_64.exe')).toBe('x86_64');
		expect(archFromName('arm64')).toBe('aarch64');
		expect(archFromName('i686')).toBe('x86_64');
		expect(archFromName('ppc64')).toBeUndefined();
		expect(systemBinary('aarch64')).toBe('qemu-system-aarch64');
	});

	it('treats VMs without an architecture as x86-64', () => {
		expect(guestArch({})).toBe('x86_64');
		expect(guestArch({ arch: 'aarch64' })).toBe('aarch64');
	});
});

describe('accelerators per host and guest pair', () => {
	it('uses the platform hypervisor only for a guest of the host architecture', () => {
		expect(acceleratorsFor('aarch64', 'darwin', 'auto', 'aarch64')).toEqual(['hvf', 'tcg']);
		expect(acceleratorsFor('x86_64', 'darwin', 'auto', 'aarch64')).toEqual(['tcg']);
		expect(acceleratorsFor('x86_64', 'linux', 'auto', 'x86_64')).toEqual(['kvm', 'tcg']);
		expect(acceleratorsFor('aarch64', 'linux', 'auto', 'x86_64')).toEqual(['tcg']);
		expect(acceleratorsFor('aarch64', 'linux', 'auto', 'aarch64')).toEqual(['kvm', 'tcg']);
		// a forced accelerator is still ignored for a guest that cannot use it
		expect(acceleratorsFor('x86_64', 'darwin', 'hvf', 'aarch64')).toEqual(['tcg']);
		expect(acceleratorsFor('aarch64', 'darwin', 'tcg', 'aarch64')).toEqual(['tcg']);
	});

	it('is native only on a matching host', () => {
		expect(isNative('aarch64', 'aarch64')).toBe(true);
		expect(isNative('x86_64', 'aarch64')).toBe(false);
	});

	it('still drops accelerators the binary does not offer', () => {
		expect(usableAccelerators(['hvf', 'tcg'], ['tcg'])).toEqual(['tcg']);
	});
});

describe('cpuFor', () => {
	it('uses the host CPU under a hypervisor on arm64 and max under TCG', () => {
		expect(cpuFor('aarch64', 'max', ['hvf', 'tcg'])).toBe('host');
		expect(cpuFor('aarch64', 'max', ['tcg'])).toBe('max');
		expect(cpuFor('aarch64', 'cortex-a72', ['hvf', 'tcg'])).toBe('cortex-a72');
		expect(cpuFor('x86_64', 'max', ['hvf', 'tcg'])).toBe('max');
		expect(cpuFor('x86_64', '', ['tcg'])).toBe('max');
	});
});

describe('normalizeHardware', () => {
	it('replaces what the ARM machine cannot have', () => {
		expect(normalizeHardware('aarch64', { firmware: 'bios', diskBus: 'sata', nic: 'e1000', vga: 'std' })).toEqual({ firmware: 'uefi', diskBus: 'virtio', nic: 'virtio-net-pci', vga: 'virtio' });
		expect(normalizeHardware('aarch64', { firmware: 'uefi', diskBus: 'virtio', nic: 'none', vga: 'virtio' }).nic).toBe('none');
		const x86 = { firmware: 'bios' as const, diskBus: 'sata' as const, nic: 'e1000' as const, vga: 'std' as const };
		expect(normalizeHardware('x86_64', x86)).toBe(x86);
	});
});

describe('aarch64 argument set', () => {
	const args = buildArgs(base, runtime, env);

	it('uses the virt machine, the host CPU under HVF and edk2 firmware', () => {
		expect(args.slice(0, 4)).toEqual(['-name', 'arm', '-machine', 'virt']);
		expect(pairs(args)).toContain('-cpu host');
		expect(args.filter((a) => a.startsWith('if=pflash'))).toEqual([
			'if=pflash,format=raw,readonly=on,file=/fw/edk2-aarch64-code.fd',
			'if=pflash,format=raw,file=/vms/a/efivars.fd'
		]);
	});

	it('has no q35, IDE, VGA or PS/2 devices', () => {
		const text = args.join(' ');
		expect(text).not.toMatch(/q35|ide-hd|ide-cd|ide\.|-vga/);
		expect(args).toContain('virtio-gpu-pci');
		expect(args).toEqual(expect.arrayContaining(['qemu-xhci', 'usb-kbd', 'usb-tablet']));
	});

	it('boots from virtio-blk and a virtio-scsi CD', () => {
		expect(args).toContain('virtio-blk-pci,drive=disk0,bootindex=1');
		expect(args).toContain('virtio-scsi-pci,id=scsi0');
		expect(args).toContain('scsi-cd,drive=cd0,bus=scsi0.0,bootindex=2');
	});

	it('forces UEFI and virtio even for a definition that says otherwise', () => {
		const odd = buildArgs({ ...base, firmware: 'bios', diskBus: 'sata' }, runtime, env);
		expect(odd.some((a) => a.startsWith('if=pflash'))).toBe(true);
		expect(odd).toContain('virtio-blk-pci,drive=disk0,bootindex=1');
		expect(() => buildArgs(base, runtime, { accelerators: ['tcg'] })).toThrow('aarch64');
	});

	it('keeps the shared wiring: QMP, VNC, serial, guest agent, forwards', () => {
		const text = args.join(' ');
		expect(text).toContain('-vnc 127.0.0.1:1');
		expect(text).toContain('tcp:127.0.0.1:4444,server=on,wait=off');
		expect(text).toContain('org.qemu.guest_agent.0');
		expect(buildArgs({ ...base, forwards: [{ protocol: 'tcp', hostPort: 2222, guestPort: 22 }] }, runtime, env).join(' ')).toContain('hostfwd=tcp:127.0.0.1:2222-:22');
	});

	it('leaves x86-64 guests exactly as before', () => {
		const x86 = buildArgs({ ...base, arch: undefined, diskBus: 'sata', nic: 'e1000', vga: 'std' }, runtime, { accelerators: ['tcg'], firmwareCode: '/fw/x.fd' });
		expect(x86.slice(2, 4)).toEqual(['-machine', 'q35']);
		expect(x86.join(' ')).toMatch(/ide-hd.*ide-cd,drive=cd0,bus=ide\.5/);
		expect(pairs(x86)).toContain('-vga std');
		expect(x86).not.toContain('virtio-gpu-pci');
	});
});

describe('firmware detection', () => {
	// Paths are built with the platform's separator, so compare them in one spelling.
	const posix = (r: { code?: string; vars?: string }) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v).replace(/\\/g, '/')]));
	const slash = (f: string) => path.normalize(f).replace(/\\/g, '/');
	const files = new Set(['/opt/homebrew/share/qemu/edk2-aarch64-code.fd', '/opt/homebrew/share/qemu/edk2-arm-vars.fd', '/opt/homebrew/share/qemu/edk2-x86_64-code.fd', '/opt/homebrew/share/qemu/edk2-i386-vars.fd']);
	const exists = (f: string) => files.has(slash(f));

	it('finds the right code and vars per architecture', () => {
		expect(posix(findFirmware('/opt/homebrew/bin', 'aarch64', exists))).toEqual({ code: '/opt/homebrew/share/qemu/edk2-aarch64-code.fd', vars: '/opt/homebrew/share/qemu/edk2-arm-vars.fd' });
		expect(posix(findFirmware('/opt/homebrew/bin', 'x86_64', exists))).toEqual({ code: '/opt/homebrew/share/qemu/edk2-x86_64-code.fd', vars: '/opt/homebrew/share/qemu/edk2-i386-vars.fd' });
	});

	it('knows the Debian AAVMF layout and reports none when absent', () => {
		const debian = new Set(['/usr/share/AAVMF/AAVMF_CODE.fd', '/usr/share/AAVMF/AAVMF_VARS.fd']);
		expect(posix(findFirmware('/usr/bin', 'aarch64', (f) => debian.has(slash(f))))).toEqual({ code: '/usr/share/AAVMF/AAVMF_CODE.fd', vars: '/usr/share/AAVMF/AAVMF_VARS.fd' });
		expect(findFirmware('/usr/bin', 'aarch64', () => false)).toEqual({});
	});
});
