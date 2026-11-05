/** Host CPU load and memory for the node card. Parsers are pure and unit tested. */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** `Mach Virtual Memory Statistics` from `vm_stat`: what could be reclaimed without swapping, in MB. */
export function parseVmStat(output: string): number | undefined {
	const size = /page size of (\d+) bytes/.exec(output);
	if (!size) return undefined;
	const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(output)?.[1] ?? 0);
	const available = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
	return Math.round((available * Number(size[1])) / 1024 / 1024);
}

/** `MemAvailable` of /proc/meminfo, in MB. */
export function parseMemAvailable(meminfo: string): number | undefined {
	const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
	return match ? Math.round(Number(match[1]) / 1024) : undefined;
}

/**
 * Memory that programs could still get. `os.freemem()` alone is misleading: macOS keeps almost no
 * pages "free" (the rest is cache), so it would show a healthy machine as 99% full.
 */
export async function availableMemoryMB(): Promise<number> {
	try {
		if (process.platform === 'linux') {
			const value = parseMemAvailable(await fs.promises.readFile('/proc/meminfo', 'utf8'));
			if (value !== undefined) return value;
		} else if (process.platform === 'darwin') {
			const { stdout } = await execFileAsync('vm_stat', [], { timeout: 3000 });
			const value = parseVmStat(stdout);
			if (value !== undefined) return value;
		}
	} catch {
		// fall through
	}
	return Math.round(os.freemem() / 1024 / 1024);
}

interface CpuTimes {
	idle: number;
	total: number;
}

function cpuTimes(): CpuTimes {
	let idle = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		idle += cpu.times.idle;
		total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
	}
	return { idle, total };
}

export function cpuLoadBetween(previous: CpuTimes | undefined, current: CpuTimes): number | undefined {
	if (!previous) return undefined;
	const total = current.total - previous.total;
	if (total <= 0) return undefined;
	return Math.min(1, Math.max(0, 1 - (current.idle - previous.idle) / total));
}

/** Host CPU load (0..1) since the previous call; undefined on the first one. */
export class CpuLoadSampler {
	private last: CpuTimes | undefined;

	sample(): number | undefined {
		const now = cpuTimes();
		const load = cpuLoadBetween(this.last, now);
		this.last = now;
		return load;
	}
}
