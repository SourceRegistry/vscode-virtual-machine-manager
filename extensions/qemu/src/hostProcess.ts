import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { parseProcStat, parsePsSample, type ProcessSample } from './inspect';

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
