import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { ARCHS, systemBinary, type Arch } from './arch';
import { LocalHost, type Host } from './host';

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

async function candidates(configured: string | undefined, host: Host): Promise<string[]> {
	const dirs: string[] = [];
	if (configured) dirs.push(configured);
	// The remote PATH of a non-interactive ssh command is short; ask for it and add the usual places.
	const searchPath = host.remote ? await host.exec('sh', ['-c', 'echo "$PATH"'], { timeout: 30_000 }).then((r) => r.stdout.trim(), () => '') : (process.env.PATH ?? '');
	for (const entry of searchPath.split(host.remote ? ':' : path.delimiter)) if (entry) dirs.push(entry);
	if (host.platform === 'win32') {
		dirs.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu'));
		if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'qemu'));
		dirs.push('C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin');
	} else if (host.platform === 'darwin') {
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

/** Every place a firmware file for the architecture could be, in order of preference. */
export function firmwareCandidates(directory: string, arch: Arch, join: (...parts: string[]) => string = path.join): string[] {
	const dirs = [join(directory, 'share'), join(directory, '..', 'share', 'qemu'), ...FIRMWARE_DIRS];
	const names = FIRMWARE_NAMES[arch];
	return dirs.flatMap((dir) => [...names.code, ...names.vars].map((n) => join(dir, n)));
}

export function findFirmware(directory: string, arch: Arch, exists: (file: string) => boolean = existsSync, join: (...parts: string[]) => string = path.join): { code?: string; vars?: string } {
	const dirs = [join(directory, 'share'), join(directory, '..', 'share', 'qemu'), ...FIRMWARE_DIRS];
	const names = FIRMWARE_NAMES[arch];
	for (const dir of dirs) {
		const code = names.code.map((n) => join(dir, n)).find((p) => exists(p));
		if (code) return { code, vars: names.vars.map((n) => join(dir, n)).find((p) => exists(p)) };
	}
	return {};
}

/** Which of `files` exist on the host, in one round trip for a remote one. */
async function existing(host: Host, files: string[]): Promise<Set<string>> {
	if (!host.remote) {
		const found = await Promise.all(files.map(async (f) => ((await host.exists(f)) ? f : undefined)));
		return new Set(found.filter((f): f is string => !!f));
	}
	const { stdout } = await host.exec('sh', ['-c', 'for f in "$@"; do [ -e "$f" ] && echo "$f"; done; true', 'sh', ...files], { timeout: 30_000 });
	return new Set(stdout.split('\n').filter(Boolean));
}

/** Output of `-accel help`: a header line, then one accelerator per line. */
export function parseAccelHelp(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[a-z][a-z0-9-]*$/.test(line));
}

/** Locates the QEMU system emulators (x86-64 and/or aarch64) and qemu-img; reports the version. Throws when none is found. */
export async function detectQemu(configured?: string, host: Host = new LocalHost()): Promise<QemuInstallation> {
	const join = host.path.join;
	const EXE = host.platform === 'win32' ? '.exe' : '';
	for (const directory of await candidates(configured, host)) {
		const img = join(directory, `qemu-img${EXE}`);
		if (!(await host.exists(img))) continue;
		const archs: Partial<Record<Arch, ArchInstallation>> = {};
		let version: string | undefined;
		for (const arch of ARCHS) {
			const system = join(directory, `${systemBinary(arch)}${EXE}`);
			if (!(await host.exists(system))) continue;
			if (!version) {
				const { stdout } = await host.exec(system, ['--version'], { timeout: 15_000 });
				version = /version\s+([\d.]+)/i.exec(stdout)?.[1] ?? stdout.split('\n')[0]?.trim() ?? 'unknown';
			}
			const found = await existing(host, firmwareCandidates(directory, arch, join));
			const firmware = findFirmware(directory, arch, (f) => found.has(f), join);
			// Unknown (older QEMU without `-accel help`, or an error): empty list = do not filter.
			const accelerators = await host.exec(system, ['-accel', 'help'], { timeout: 15_000 })
				.then(({ stdout: out }) => parseAccelHelp(out))
				.catch(() => []);
			archs[arch] = { system, accelerators, firmwareCode: firmware.code, firmwareVarsTemplate: firmware.vars };
		}
		if (version) return { directory, img, version, archs };
	}
	if (host.remote) {
		throw new Error(
			configured
				? `No qemu-system-x86_64 or qemu-system-aarch64 was found in ${configured} on ${host.label}`
				: `QEMU was not found on ${host.label}. Install it there (for example qemu-system-x86 and qemu-utils), or set the QEMU directory of the cluster.`
		);
	}
	throw new Error(
		configured
			? `No qemu-system-x86_64 or qemu-system-aarch64 was found in ${configured}`
			: 'QEMU was not found. Install QEMU or set "vmm.qemu.path" to the directory that contains qemu-system-x86_64 (or qemu-system-aarch64).'
	);
}
