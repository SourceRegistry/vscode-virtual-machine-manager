import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parseProcStat, parsePsSample, type ProcessSample } from './inspect';
import { parsePsList, type ProcessEntry } from './scan';

const execFileAsync = promisify(execFile);

/** CPU time and resident memory of a host process, or undefined when it is gone / unreadable. */
export async function sampleProcess(pid: number): Promise<ProcessSample | undefined> {
	try {
		if (process.platform === 'linux') {
			const [stat, status] = await Promise.all([
				fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'),
				fs.promises.readFile(`/proc/${pid}/status`, 'utf8')
			]);
			return parseProcStat(stat, status);
		}
		if (process.platform === 'win32') {
			const script = `$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop; '{0} {1}' -f $p.TotalProcessorTime.TotalSeconds.ToString([cultureinfo]::InvariantCulture), $p.WorkingSet64`;
			const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 });
			const [cpu, ws] = stdout.trim().split(' ').map(Number);
			return Number.isFinite(cpu) && Number.isFinite(ws) ? { cpuSeconds: cpu!, rssMB: Math.round(ws! / 1024 / 1024) } : undefined;
		}
		const { stdout } = await execFileAsync('ps', ['-o', 'time=,rss=', '-p', String(Math.trunc(pid))], { timeout: 5000 });
		return parsePsSample(stdout);
	} catch {
		return undefined;
	}
}

/** Every process as pid + command line (Windows: only the QEMU ones, where `ps` does not exist). */
export async function listProcesses(): Promise<ProcessEntry[]> {
	try {
		if (process.platform === 'win32') {
			const script = "Get-CimInstance Win32_Process -Filter \"Name like 'qemu-system%'\" | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }";
			const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
			return parsePsList(stdout);
		}
		// `ww`: do not truncate long command lines.
		const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,command='], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
		return parsePsList(stdout);
	} catch {
		return [];
	}
}

/** When the process started (epoch ms), or undefined when unknown. */
export async function processStartedAt(pid: number): Promise<number | undefined> {
	try {
		if (process.platform === 'win32') return undefined;
		const { stdout } = await execFileAsync('ps', ['-o', 'etime=', '-p', String(Math.trunc(pid))], { timeout: 5000 });
		const seconds = parseEtime(stdout);
		return seconds === undefined ? undefined : Date.now() - seconds * 1000;
	} catch {
		return undefined;
	}
}

/** `ps -o etime=`: `SS`-less `MM:SS`, `HH:MM:SS` or `D-HH:MM:SS` → seconds. */
export function parseEtime(text: string): number | undefined {
	const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(text);
	if (!match) return undefined;
	const [, d, h, m, s] = match;
	return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.Trash', 'Library', '$RECYCLE.BIN']);

/** Files below `root` (breadth-limited so a mistaken choice like `/` cannot run away). */
export async function walkFiles(root: string, maxDepth = 4, maxFiles = 5000): Promise<string[]> {
	const files: string[] = [];
	const visit = async (dir: string, depth: number): Promise<void> => {
		if (files.length >= maxFiles) return;
		const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (files.length >= maxFiles) return;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < maxDepth && !SKIP_DIRECTORIES.has(entry.name)) await visit(full, depth + 1);
			} else if (entry.isFile()) {
				files.push(full);
			}
		}
	};
	await visit(root, 0);
	return files;
}
