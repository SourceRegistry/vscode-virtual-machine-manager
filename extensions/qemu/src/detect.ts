import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXE = process.platform === 'win32' ? '.exe' : '';

export interface QemuInstallation {
	directory: string;
	system: string;
	img: string;
	version: string;
	firmwareCode?: string;
	firmwareVarsTemplate?: string;
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

function findFirmware(directory: string): { code?: string; vars?: string } {
	const dirs = [
		path.join(directory, 'share'),
		path.join(directory, '..', 'share', 'qemu'),
		'/usr/share/qemu',
		'/usr/share/OVMF',
		'/usr/share/ovmf',
		'/usr/share/edk2/ovmf',
		'/usr/share/edk2/x64',
		'/opt/homebrew/share/qemu',
		'/usr/local/share/qemu'
	];
	const codeNames = ['edk2-x86_64-code.fd', 'OVMF_CODE_4M.fd', 'OVMF_CODE.fd'];
	const varsNames = ['edk2-i386-vars.fd', 'OVMF_VARS_4M.fd', 'OVMF_VARS.fd'];
	for (const dir of dirs) {
		const code = codeNames.map((n) => path.join(dir, n)).find((p) => existsSync(p));
		if (code) return { code, vars: varsNames.map((n) => path.join(dir, n)).find((p) => existsSync(p)) };
	}
	return {};
}

/** Locates qemu-system-x86_64 + qemu-img and reports the version. Throws when not found. */
export async function detectQemu(configured?: string): Promise<QemuInstallation> {
	for (const directory of candidates(configured)) {
		const system = path.join(directory, `qemu-system-x86_64${EXE}`);
		const img = path.join(directory, `qemu-img${EXE}`);
		if (!existsSync(system) || !existsSync(img)) continue;
		const { stdout } = await execFileAsync(system, ['--version'], { windowsHide: true, timeout: 15_000 });
		const version = /version\s+([\d.]+)/i.exec(stdout)?.[1] ?? stdout.split('\n')[0]?.trim() ?? 'unknown';
		const firmware = findFirmware(directory);
		return { directory, system, img, version, firmwareCode: firmware.code, firmwareVarsTemplate: firmware.vars };
	}
	throw new Error(
		configured
			? `qemu-system-x86_64 was not found in ${configured}`
			: 'QEMU was not found. Install QEMU or set "vmm.qemu.path" to the directory that contains qemu-system-x86_64.'
	);
}
