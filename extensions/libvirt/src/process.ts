import { execFile } from 'node:child_process';

export interface QemuProcess { pid: number; cpuPercent: number; rssMB: number; uptimeSeconds?: number }

/** `[[dd-]hh:]mm:ss` as printed by `ps -o etime`. */
export function parseEtime(value: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
	if (!match) return undefined;
	const [, d, h, m, s] = match;
	return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * libvirt starts QEMU with `-name guest=<domain>,...`. `ps` output is parsed into one entry per domain name.
 * Used on this computer when libvirt itself cannot say (macOS has no cgroups, so its CPU time is 0).
 */
export function parseProcesses(output: string): Map<string, QemuProcess> {
	const result = new Map<string, QemuProcess>();
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const guest = /(?:^|\s)-name\s+(?:guest=)?([^,\s]+)/.exec(match[5]!);
		if (!guest || !/qemu-system/.test(match[5]!)) continue;
		result.set(guest[1]!, { pid: Number(match[1]), cpuPercent: Number(match[2]!.replace(',', '.')), rssMB: Math.round(Number(match[3]) / 1024), uptimeSeconds: parseEtime(match[4]!) });
	}
	return result;
}

export function sampleProcesses(): Promise<Map<string, QemuProcess>> {
	if (process.platform === 'win32') return Promise.resolve(new Map());
	return new Promise((resolve) => {
		execFile('ps', ['-axo', 'pid=,%cpu=,rss=,etime=,command='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? new Map() : parseProcesses(stdout)));
	});
}
