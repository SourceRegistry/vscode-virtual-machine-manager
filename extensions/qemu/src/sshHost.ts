/**
 * A QEMU host reached with the system `ssh` client: no library, so the user's agent, keys, `~/.ssh/config`
 * (aliases, ProxyJump…) and known_hosts all apply. Linux hosts only. Commands run through the remote
 * shell with POSIX tools; the control, display and serial ports of the VMs (loopback TCP on the host)
 * are reached with `ssh -W`, one stream each, so nothing listens on this computer.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import type { DirEntry, ExecOptions, Host, HostInfo } from './host';
import { sleepMs } from './host';
import type { ProcessSample } from './inspect';
import { parseProcStat } from './inspect';
import { parsePsList, type ProcessEntry } from './scan';

export interface SshTarget {
	/** A host name, address or an alias of the user's ssh config. */
	host: string;
	user?: string;
	port?: number;
	/** Private key file; empty = what the agent and ssh config offer. */
	identityFile?: string;
}

const MARKER = '@@VMM@@';

/** Single-quotes a word for a POSIX shell. */
export function shq(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(file: string, args: string[]): string {
	return [file, ...args].map(shq).join(' ');
}

/** Rejects what ssh could read as an option or a second destination. */
export function validateSshTarget(target: SshTarget): string | undefined {
	if (!target.host?.trim()) return 'The SSH host is empty.';
	if (!/^[A-Za-z0-9._:%@\[\]-]+$/.test(target.host) || target.host.startsWith('-')) return `"${target.host}" is not a valid SSH host name.`;
	if (target.user !== undefined && target.user !== '' && (!/^[A-Za-z0-9._][A-Za-z0-9._@-]*$/.test(target.user))) return `"${target.user}" is not a valid SSH user name.`;
	if (target.port !== undefined && !(Number.isInteger(target.port) && target.port >= 1 && target.port <= 65535)) return `${target.port} is not a valid SSH port.`;
	if (target.identityFile && (target.identityFile.startsWith('-') || target.identityFile.includes('\n'))) return 'The identity file path is not valid.';
	return undefined;
}

export function sshLabel(target: SshTarget): string {
	return `${target.user ? `${target.user}@` : ''}${target.host}${target.port ? `:${target.port}` : ''}`;
}

export interface SshArgOptions {
	/** Directory for the multiplexing socket; undefined = no multiplexing (Windows). */
	controlDir?: string;
}

/**
 * Arguments before the destination. Never asks anything (`BatchMode`): a password or an unknown host key
 * would hang a background connection, so those fail with a message instead.
 */
export function sshBaseArgs(target: SshTarget, options: SshArgOptions = {}): string[] {
	const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
	if (options.controlDir) args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${options.controlDir}/%C`, '-o', 'ControlPersist=300');
	if (target.port) args.push('-p', String(target.port));
	if (target.user) args.push('-l', target.user);
	if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes');
	return args;
}

/** A readable reason for what `ssh` printed when it could not connect. */
export function explainSshError(stderr: string, target: SshTarget): string {
	const text = stderr.trim();
	const where = sshLabel(target);
	if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
		return /CHANGED/i.test(text)
			? `The host key of ${where} changed. If that is expected, remove the old key with: ssh-keygen -R ${target.host}`
			: `${where} is not in your known_hosts. Connect once in a terminal (ssh ${target.host}) to check and accept its host key.`;
	}
	if (/Permission denied/i.test(text)) return `${where} refused the login (${text.match(/\(([^)]*)\)/)?.[1] ?? 'permission denied'}). VM Manager cannot type a password: use a key, added to ssh-agent if it has a passphrase.`;
	if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(text)) return `The host name ${target.host} could not be resolved.`;
	if (/Connection refused/i.test(text)) return `${where} refused the connection: is sshd running there?`;
	if (/timed out/i.test(text)) return `${where} did not answer in time.`;
	if (/No route to host|Network is unreachable/i.test(text)) return `${where} cannot be reached from this computer.`;
	if (/spawn ssh ENOENT/i.test(text)) return 'The ssh program was not found. Install an OpenSSH client.';
	return text.split('\n').slice(-2).join(' ') || `Could not run a command on ${where}.`;
}

/** `ls -1Ap`: directories end with a slash. */
export function parseLs(output: string): DirEntry[] {
	return output
		.split('\n')
		.filter((line) => line && line !== './' && line !== '../')
		.map((line) => (line.endsWith('/') ? { name: line.slice(0, -1), isDirectory: true } : { name: line, isDirectory: false }));
}

/** Ports in LISTEN state from `ss -ltn` or `netstat -ltn` (the local address is the fourth column; macOS writes `addr.port`). */
export function parseListeningPorts(output: string): Set<number> {
	const ports = new Set<number>();
	for (const line of output.split('\n')) {
		if (!/LISTEN/i.test(line)) continue;
		const match = /[.:](\d+)$/.exec(line.trim().split(/\s+/)[3] ?? '');
		if (match) ports.add(Number(match[1]));
	}
	return ports;
}

/** Output of the `readChildren` script. */
export function parseChildren(output: string): Array<[string, string]> {
	const result: Array<[string, string]> = [];
	const parts = output.split(new RegExp(`^${MARKER}(.*)$`, 'm'));
	for (let i = 1; i + 1 < parts.length; i += 2) result.push([parts[i]!, parts[i + 1]!.replace(/^\n/, '').replace(/\n$/, '')]);
	return result;
}

interface CpuTimes {
	idle: number;
	total: number;
}

/** First line of /proc/stat. */
export function parseProcStatCpu(line: string): CpuTimes | undefined {
	const fields = line.trim().split(/\s+/);
	if (fields[0] !== 'cpu') return undefined;
	const numbers = fields.slice(1, 9).map(Number);
	if (numbers.some((n) => !Number.isFinite(n))) return undefined;
	const idle = (numbers[3] ?? 0) + (numbers[4] ?? 0);
	return { idle, total: numbers.reduce((a, b) => a + b, 0) };
}

/** Output of the `info` script: hostname, cpu count, `uname -sm`, meminfo lines, then the first line of /proc/stat. */
export function parseHostInfo(output: string): { hostname: string; cpus: number; system: string; machine: string; memoryMB: number; availableMB: number; cpu: CpuTimes | undefined } {
	const lines = output.split('\n');
	const [system = '', machine = ''] = (lines[2] ?? '').trim().split(/\s+/);
	const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(output)?.[1] ?? 0);
	const total = kb('MemTotal');
	return {
		hostname: (lines[0] ?? '').trim(),
		cpus: Math.max(1, Number((lines[1] ?? '').trim()) || 1),
		system,
		machine,
		memoryMB: Math.round(total / 1024),
		availableMB: Math.round((kb('MemAvailable') || kb('MemFree')) / 1024),
		cpu: parseProcStatCpu(output.split('\n').find((l) => l.startsWith('cpu ')) ?? '')
	};
}

/** Node's name for a `uname -m`. */
export function nodeArch(machine: string): string {
	if (machine === 'x86_64' || machine === 'amd64') return 'x64';
	if (machine === 'aarch64' || machine === 'arm64') return 'arm64';
	return machine;
}

/** A stream to a remote TCP port, carried by `ssh -W`. Closing it ends the ssh process. */
export class SshStream extends Duplex {
	private received = false;
	private stderr = '';

	constructor(private readonly child: ChildProcess, private readonly target: SshTarget) {
		super();
		child.stdout!.on('data', (chunk: Buffer) => {
			this.received = true;
			this.push(chunk);
		});
		child.stderr!.on('data', (chunk: Buffer) => (this.stderr += chunk.toString()));
		child.stdin!.on('error', () => undefined);
		child.once('error', (error) => this.destroy(new Error(explainSshError(String(error), target))));
		child.once('exit', (code) => {
			if (this.destroyed) return;
			if (code !== 0 && !this.received) this.destroy(new Error(this.failure()));
			else this.push(null);
		});
	}

	/** Whether the remote end has said anything yet. */
	get hasData(): boolean {
		return this.received;
	}

	get exited(): boolean {
		return this.child.exitCode !== null || this.child.signalCode !== null;
	}

	failure(): string {
		const text = this.stderr.trim();
		return /connect.*failed|Connection refused|administratively prohibited/i.test(text)
			? 'nothing is listening on that port, or the host forbids port forwarding (AllowTcpForwarding)'
			: explainSshError(text, this.target);
	}

	override _read(): void {}

	override _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
		if (this.child.stdin!.destroyed) return callback(new Error('The connection is closed'));
		this.child.stdin!.write(chunk, (error) => callback(error ?? null));
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.child.stdin!.end();
		callback();
	}

	override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this.child.kill();
		callback(error);
	}

	setNoDelay(): this {
		return this;
	}
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface SshHostOptions {
	/** The ssh program; tests point it at a stand-in. */
	command?: string;
	/** Extra `-o` style arguments, placed before the destination. */
	extraArgs?: string[];
	/** Skip the Linux check (tests run the "remote" commands on the development machine). */
	anyPlatform?: boolean;
}

export class SshHost implements Host {
	readonly remote = true;
	readonly platform: NodeJS.Platform = 'linux';
	arch: string = 'x64';
	readonly path = path.posix;
	readonly label: string;
	private readonly command: string;
	private readonly base: string[];
	private readonly controlDir: string | undefined;
	private cpuBefore: CpuTimes | undefined;
	private readonly anyPlatform: boolean;

	constructor(
		private readonly target: SshTarget,
		options: SshHostOptions = {}
	) {
		const problem = validateSshTarget(target);
		if (problem) throw new Error(problem);
		this.label = sshLabel(target);
		this.command = options.command ?? 'ssh';
		this.anyPlatform = !!options.anyPlatform;
		this.controlDir = process.platform === 'win32' ? undefined : controlDirectory();
		this.base = [...sshBaseArgs(target, { controlDir: this.controlDir }), ...(options.extraArgs ?? [])];
	}

	/** Connects, checks that this is a Linux host and learns its architecture. */
	async ping(): Promise<void> {
		const result = await this.run(shellCommand('uname', ['-sm']), { timeout: 30_000 });
		if (result.code !== 0) throw new Error(explainSshError(result.stderr, this.target));
		const [system, machine] = result.stdout.trim().split(/\s+/);
		if (system !== 'Linux' && !this.anyPlatform) throw new Error(`${this.label} runs ${system || 'an unknown system'}. Only Linux hosts are supported over SSH.`);
		this.arch = nodeArch(machine ?? '');
	}

	private run(command: string, options: ExecOptions = {}): Promise<RunResult> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.command, [...this.base, this.target.host, command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
			let stdout = '';
			let stderr = '';
			const timer = options.timeout
				? setTimeout(() => {
						child.kill();
						reject(new Error(`${this.label} did not answer in time.`));
					}, options.timeout)
				: undefined;
			child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
			child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
			child.stdin.on('error', () => undefined);
			child.once('error', (error) => {
				clearTimeout(timer);
				reject(new Error(explainSshError(String(error), this.target)));
			});
			child.once('close', (code) => {
				clearTimeout(timer);
				resolve({ code, stdout, stderr });
			});
			child.stdin.end(options.input ?? '');
		});
	}

	/** Runs a shell command; rejects with a readable message on a non-zero exit. */
	private async sh(command: string, options: ExecOptions = {}): Promise<string> {
		const result = await this.run(command, options);
		if (result.code !== 0) {
			throw new Error(result.code === 255 ? explainSshError(result.stderr, this.target) : result.stderr.trim() || `The command failed (exit ${result.code}) on ${this.label}`);
		}
		return result.stdout;
	}

	async exec(file: string, args: string[], options: ExecOptions = {}): Promise<{ stdout: string }> {
		return { stdout: await this.sh(shellCommand(file, args), options) };
	}

	readFile(file: string): Promise<string> {
		return this.sh(shellCommand('cat', ['--', file]), { timeout: 60_000 });
	}

	async writeFile(file: string, data: string): Promise<void> {
		await this.sh(`cat > ${shq(file)}`, { input: data, timeout: 60_000 });
	}

	async mkdir(dir: string): Promise<void> {
		await this.sh(shellCommand('mkdir', ['-p', '--', dir]));
	}

	async rm(target: string, options: { recursive?: boolean } = {}): Promise<void> {
		await this.sh(shellCommand('rm', [options.recursive ? '-rf' : '-f', '--', target]), { timeout: 120_000 });
	}

	async exists(file: string): Promise<boolean> {
		const result = await this.run(shellCommand('test', ['-e', file]), { timeout: 30_000 });
		if (result.code === 0) return true;
		if (result.code === 255) throw new Error(explainSshError(result.stderr, this.target));
		return false;
	}

	async readdir(dir: string): Promise<DirEntry[]> {
		const result = await this.run(shellCommand('ls', ['-1Ap', '--', dir]), { timeout: 30_000 });
		if (result.code === 255) throw new Error(explainSshError(result.stderr, this.target));
		return result.code === 0 ? parseLs(result.stdout) : [];
	}

	async copyFile(from: string, to: string): Promise<void> {
		await this.sh(shellCommand('cp', ['--', from, to]), { timeout: 10 * 60_000 });
	}

	async readChildren(dir: string, file: string): Promise<Array<[string, string]>> {
		const script = `cd ${shq(dir)} 2>/dev/null || exit 0; for d in */; do d=\${d%/}; [ -f "$d"/${shq(file)} ] || continue; printf '${MARKER}%s\\n' "$d"; cat "$d"/${shq(file)}; printf '\\n'; done`;
		return parseChildren(await this.sh(script, { timeout: 60_000 }));
	}

	async spawnDetached(file: string, args: string[], options: { cwd: string; logFile: string }): Promise<number> {
		const pidFile = `${options.logFile}.pid`;
		// `exec` keeps the pid of the shell for the program. The job is started from a brace group (not a `&&` list)
		// so that only it, with its own redirects, outlives the command: otherwise ssh waits for the program to end.
		const script =
			`cd ${shq(options.cwd)} && rm -f ${shq(pidFile)} && ` +
			`{ nohup sh -c 'echo $$ > "$0"; exec "$@"' ${shq(pidFile)} ${shellCommand(file, args)} > ${shq(options.logFile)} 2>&1 < /dev/null & }; ` +
			`i=0; while [ ! -s ${shq(pidFile)} ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; cat ${shq(pidFile)}`;
		const pid = Number((await this.sh(script, { timeout: 30_000 })).trim());
		if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${file} could not be started on ${this.label}`);
		return pid;
	}

	async isAlive(pid: number): Promise<boolean> {
		if (!pid) return false;
		const result = await this.run(`kill -0 ${Math.trunc(pid)}`, { timeout: 30_000 });
		if (result.code === 255) throw new Error(explainSshError(result.stderr, this.target));
		return result.code === 0 || /not permitted/i.test(result.stderr);
	}

	async signal(pid: number, name: 'SIGTERM' | 'SIGKILL'): Promise<void> {
		await this.run(`kill -${name === 'SIGKILL' ? 'KILL' : 'TERM'} ${Math.trunc(pid)}`, { timeout: 30_000 });
	}

	async connect(port: number, address = '127.0.0.1'): Promise<Duplex> {
		const child = spawn(this.command, [...this.base, '-W', `${address}:${port}`, this.target.host], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		const stream = new SshStream(child, this.target);
		// `-W` has no "connected" signal: it either dies within moments or stays. Wait for the first
		// byte (VNC and QMP greet), a failure, or a short quiet period (a serial port says nothing).
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(done, 700);
			const poll = setInterval(() => stream.hasData && done(), 20);
			stream.once('error', (error) => finish(() => reject(new Error(`${error.message}`))));
			stream.once('close', () => finish(() => reject(new Error(stream.failure()))));
			function finish(action: () => void): void {
				clearTimeout(timer);
				clearInterval(poll);
				action();
			}
			function done(): void {
				finish(resolve);
			}
		});
		return stream;
	}

	async freePort(min?: number, max?: number, avoid: ReadonlySet<number> = new Set()): Promise<number> {
		const output = await this.sh('ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || netstat -an 2>/dev/null || true', { timeout: 30_000 });
		const used = parseListeningPorts(output);
		if (min === undefined) {
			for (let tries = 0; tries < 200; tries++) {
				const port = 20000 + Math.floor(Math.random() * 40000);
				if (!used.has(port) && !avoid.has(port)) return port;
			}
			throw new Error('No free TCP port available on the host');
		}
		for (let port = min; port <= (max ?? min); port++) if (!used.has(port) && !avoid.has(port)) return port;
		throw new Error(`No free TCP port between ${min} and ${max} on the host`);
	}

	async info(): Promise<HostInfo> {
		const output = await this.sh("hostname; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN; uname -sm; grep -E '^(MemTotal|MemAvailable|MemFree):' /proc/meminfo; head -n1 /proc/stat; true", { timeout: 30_000 });
		const parsed = parseHostInfo(output);
		const cpu = parsed.cpu;
		let load: number | undefined;
		if (cpu && this.cpuBefore) {
			const total = cpu.total - this.cpuBefore.total;
			if (total > 0) load = Math.min(1, Math.max(0, 1 - (cpu.idle - this.cpuBefore.idle) / total));
		}
		this.cpuBefore = cpu;
		return {
			hostname: parsed.hostname || this.target.host,
			cpus: parsed.cpus,
			memoryMB: parsed.memoryMB,
			availableMemoryMB: parsed.availableMB,
			cpuLoad: load,
			platform: `${parsed.system.toLowerCase()} ${nodeArch(parsed.machine)}`
		};
	}

	async sampleProcess(pid: number): Promise<ProcessSample | undefined> {
		const result = await this.run(`cat /proc/${Math.trunc(pid)}/stat && echo ${MARKER} && cat /proc/${Math.trunc(pid)}/status`, { timeout: 30_000 });
		if (result.code !== 0) return undefined;
		const [stat, status] = result.stdout.split(`${MARKER}\n`);
		return stat && status ? parseProcStat(stat, status) : undefined;
	}

	async listProcesses(): Promise<ProcessEntry[]> {
		const result = await this.run('ps -axww -o pid=,command=', { timeout: 30_000 });
		return result.code === 0 ? parsePsList(result.stdout) : [];
	}

	dispose(): void {
		if (!this.controlDir) return;
		// Close the shared connection now instead of after ControlPersist.
		spawn(this.command, [...this.base, '-O', 'exit', this.target.host], { stdio: 'ignore', windowsHide: true }).once('error', () => undefined);
	}
}

let controlDirectoryPath: string | undefined;

/** Short and private: the socket path has a ~100 character limit, which the system temp directory on macOS nearly exhausts. */
function controlDirectory(): string | undefined {
	if (controlDirectoryPath) return controlDirectoryPath;
	try {
		const uid = process.getuid?.() ?? 0;
		const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
		const dir = path.join(base, `vmm-ssh-${uid}`);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
		controlDirectoryPath = dir;
	} catch {
		controlDirectoryPath = undefined;
	}
	return controlDirectoryPath;
}

export { sleepMs };
