import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { ARCHS, systemBinary, type Arch } from './arch';

const execFileAsync = promisify(execFile);
const EXE = process.platform === 'win32' ? '.exe' : '';

export interface ArchInstallation {
	/** The `qemu-system-<arch>` binary. */
	system: string;
	/** Accelerators this binary can use (`-accel help`), e.g. `['tcg', 'hvf']`. Empty = unknown. */
	accelerators: string[];
	firmwareCode?: string;
	firmwareVarsTemplate?: string;
}

export interface QemuInstallation {
	directory: string;
	img: string;
	version: string;
	/** The guest architectures this installation can run. Never empty. */
	archs: Partial<Record<Arch, ArchInstallation>>;
}

function candidates(configured: string | undefined): string[] {
	const dirs: string[] = [];
	if (configured) dirs.push(configured);
	for (const entry of (process.env.PATH ?? '').split(path.delimiter)) if (entry) dirs.push(entry);
	if (process.platform === 'win32') {
		dirs.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu'));
		if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'qemu'));
		dirs.push('C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin');
	} else if (process.platform === 'darwin') {
		dirs.push('/opt/homebrew/bin', '/usr/local/bin');
	} else {
		dirs.push('/usr/bin', '/usr/local/bin', '/usr/libexec');
	}
	return [...new Set(dirs)];
}

const FIRMWARE_DIRS = [
	'/usr/share/qemu',
	'/usr/share/OVMF',
	'/usr/share/ovmf',
	'/usr/share/edk2/ovmf',
	'/usr/share/edk2/x64',
	'/usr/share/AAVMF',
	'/usr/share/edk2/aarch64',
	'/usr/share/qemu-efi-aarch64',
	'/opt/homebrew/share/qemu',
	'/usr/local/share/qemu'
];

/**
 * Firmware names per architecture. aarch64 firmware is 64 MiB flash; the variable store must be the
 * same size, and QEMU ships `edk2-arm-vars.fd` for it (there is no `edk2-aarch64-vars.fd`).
 */
const FIRMWARE_NAMES: Record<Arch, { code: string[]; vars: string[] }> = {
	x86_64: { code: ['edk2-x86_64-code.fd', 'OVMF_CODE_4M.fd', 'OVMF_CODE.fd'], vars: ['edk2-i386-vars.fd', 'OVMF_VARS_4M.fd', 'OVMF_VARS.fd'] },
	aarch64: { code: ['edk2-aarch64-code.fd', 'AAVMF_CODE.fd'], vars: ['edk2-arm-vars.fd', 'AAVMF_VARS.fd'] }
};

export function findFirmware(directory: string, arch: Arch, exists: (file: string) => boolean = existsSync): { code?: string; vars?: string } {
	const dirs = [path.join(directory, 'share'), path.join(directory, '..', 'share', 'qemu'), ...FIRMWARE_DIRS];
	const names = FIRMWARE_NAMES[arch];
	for (const dir of dirs) {
		const code = names.code.map((n) => path.join(dir, n)).find((p) => exists(p));
		if (code) return { code, vars: names.vars.map((n) => path.join(dir, n)).find((p) => exists(p)) };
	}
	return {};
}

/** Output of `-accel help`: a header line, then one accelerator per line. */
export function parseAccelHelp(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[a-z][a-z0-9-]*$/.test(line));
}

/** Locates the QEMU system emulators (x86-64 and/or aarch64) and qemu-img; reports the version. Throws when none is found. */
export async function detectQemu(configured?: string): Promise<QemuInstallation> {
	for (const directory of candidates(configured)) {
		const img = path.join(directory, `qemu-img${EXE}`);
		if (!existsSync(img)) continue;
		const archs: Partial<Record<Arch, ArchInstallation>> = {};
		let version: string | undefined;
		for (const arch of ARCHS) {
			const system = path.join(directory, `${systemBinary(arch)}${EXE}`);
			if (!existsSync(system)) continue;
			if (!version) {
				const { stdout } = await execFileAsync(system, ['--version'], { windowsHide: true, timeout: 15_000 });
				version = /version\s+([\d.]+)/i.exec(stdout)?.[1] ?? stdout.split('\n')[0]?.trim() ?? 'unknown';
			}
			const firmware = findFirmware(directory, arch);
			// Unknown (older QEMU without `-accel help`, or an error): empty list = do not filter.
			const accelerators = await execFileAsync(system, ['-accel', 'help'], { windowsHide: true, timeout: 15_000 })
				.then(({ stdout: out }) => parseAccelHelp(out))
				.catch(() => []);
			archs[arch] = { system, accelerators, firmwareCode: firmware.code, firmwareVarsTemplate: firmware.vars };
		}
		if (version) return { directory, img, version, archs };
	}
	throw new Error(
		configured
			? `No qemu-system-x86_64 or qemu-system-aarch64 was found in ${configured}`
			: 'QEMU was not found. Install QEMU or set "vmm.qemu.path" to the directory that contains qemu-system-x86_64 (or qemu-system-aarch64).'
	);
}
