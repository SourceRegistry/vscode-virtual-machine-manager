/**
 * Where a QEMU cluster lives. `LocalHost` is this computer; `SshHost` (sshHost.ts) is another one reached
 * with the system `ssh`. The provider only talks to a `Host`, so both behave the same.
 */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { availableMemoryMB, CpuLoadSampler } from './hostInfo';
import { listProcesses, processStartedAt, sampleProcess } from './hostProcess';
import type { ProcessSample } from './inspect';
import type { ProcessEntry } from './scan';

const execFileAsync = promisify(execFile);

export interface DirEntry {
	name: string;
	isDirectory: boolean;
}

export interface ExecOptions {
	/** Milliseconds; the command is killed after that. */
	timeout?: number;
	/** Text for the command's standard input. */
	input?: string;
}

export interface HostInfo {
	hostname: string;
	cpus: number;
	memoryMB: number;
	availableMemoryMB: number;
	/** 0..1 since the previous call; undefined on the first one. */
	cpuLoad: number | undefined;
	/** e.g. `linux x64`. */
	platform: string;
}

export interface Host {
	/** True when this is another computer: its paths are not valid here and vice versa. */
	readonly remote: boolean;
	readonly platform: NodeJS.Platform;
	/** Node's name for the CPU architecture (`x64`, `arm64`). */
	readonly arch: string;
	/** Path functions of the host (POSIX for every remote host). */
	readonly path: path.PlatformPath;
	/** Short description for the user: `This computer` or `user@host`. */
	readonly label: string;
	/** Fails the connection test early with a readable reason. */
	ping(): Promise<void>;
	exec(file: string, args: string[], options?: ExecOptions): Promise<{ stdout: string }>;
	readFile(file: string): Promise<string>;
	writeFile(file: string, data: string): Promise<void>;
	mkdir(dir: string): Promise<void>;
	rm(target: string, options?: { recursive?: boolean }): Promise<void>;
	exists(file: string): Promise<boolean>;
	readdir(dir: string): Promise<DirEntry[]>;
	copyFile(from: string, to: string): Promise<void>;
	/** `file` in every sub-directory of `dir` that has one, as `[directory name, text]`. */
	readChildren(dir: string, file: string): Promise<Array<[string, string]>>;
	/** Starts a program that outlives this process; its output goes to `logFile`. Returns its pid. */
	spawnDetached(file: string, args: string[], options: { cwd: string; logFile: string }): Promise<number>;
	isAlive(pid: number): Promise<boolean>;
	signal(pid: number, name: 'SIGTERM' | 'SIGKILL'): Promise<void>;
	/** A stream to a TCP port on the host's loopback. */
	connect(port: number, address?: string): Promise<Duplex>;
	/** A stream to a unix socket on the host (a QEMU started by someone else may only have those). */
	connectSocket(socketPath: string): Promise<Duplex>;
	/** When the process started (epoch ms), or undefined when unknown. */
	processStartedAt(pid: number): Promise<number | undefined>;
	/** A TCP port nobody listens on, within [min, max] when given. */
	freePort(min?: number, max?: number, avoid?: ReadonlySet<number>): Promise<number>;
	info(): Promise<HostInfo>;
	sampleProcess(pid: number): Promise<ProcessSample | undefined>;
	/** Command lines of all processes (to find QEMUs started elsewhere). */
	listProcesses(): Promise<ProcessEntry[]>;
	dispose(): void;
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryListen(port: number): Promise<number | undefined> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.unref();
		server.once('error', () => resolve(undefined));
		server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
			const address = server.address();
			const actual = typeof address === 'object' && address ? address.port : undefined;
			server.close(() => resolve(actual));
		});
	});
}

/**
 * A free localhost port; within [min, max] when given (VNC needs 5900 + display). Ports in `avoid`
 * (held by running VMs, or just refused) are skipped. Note that this only *probes*: the port is not
 * held after it returns.
 */
export async function freeLocalPort(min?: number, max?: number, avoid: ReadonlySet<number> = new Set()): Promise<number> {
	if (min === undefined) {
		for (let tries = 0; tries < 20; tries++) {
			const port = await tryListen(0);
			if (!port) throw new Error('No free TCP port available');
			if (!avoid.has(port)) return port;
		}
		throw new Error('No free TCP port available');
	}
	for (let port = min; port <= (max ?? min); port++) {
		if (!avoid.has(port) && (await tryListen(port))) return port;
	}
	throw new Error(`No free TCP port between ${min} and ${max}`);
}

/** This computer. Behaviour is what the provider always did directly. */
export class LocalHost implements Host {
	readonly remote = false;
	readonly platform = process.platform;
	readonly arch = process.arch;
	readonly path = path;
	readonly label = 'This computer';
	private readonly cpu = new CpuLoadSampler();

	async ping(): Promise<void> {}

	async exec(file: string, args: string[], options: ExecOptions = {}): Promise<{ stdout: string }> {
		const { stdout } = await execFileAsync(file, args, { windowsHide: true, timeout: options.timeout, maxBuffer: 32 * 1024 * 1024 });
		return { stdout };
	}

	readFile(file: string): Promise<string> {
		return fs.promises.readFile(file, 'utf8');
	}

	async writeFile(file: string, data: string): Promise<void> {
		await fs.promises.writeFile(file, data);
	}

	async mkdir(dir: string): Promise<void> {
		await fs.promises.mkdir(dir, { recursive: true });
	}

	async rm(target: string, options: { recursive?: boolean } = {}): Promise<void> {
		await fs.promises.rm(target, { recursive: !!options.recursive, force: true });
	}

	async exists(file: string): Promise<boolean> {
		return fs.existsSync(file);
	}

	async readdir(dir: string): Promise<DirEntry[]> {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
		return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
	}

	async copyFile(from: string, to: string): Promise<void> {
		await fs.promises.copyFile(from, to);
	}

	async readChildren(dir: string, file: string): Promise<Array<[string, string]>> {
		const result: Array<[string, string]> = [];
		for (const entry of await this.readdir(dir)) {
			if (!entry.isDirectory) continue;
			try {
				result.push([entry.name, await fs.promises.readFile(path.join(dir, entry.name, file), 'utf8')]);
			} catch {
				// no such file in this directory
			}
		}
		return result;
	}

	async spawnDetached(file: string, args: string[], options: { cwd: string; logFile: string }): Promise<number> {
		const logFd = fs.openSync(options.logFile, 'w');
		const child = spawn(file, args, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, cwd: options.cwd });
		fs.closeSync(logFd);
		child.once('error', () => undefined);
		child.unref();
		if (!child.pid) throw new Error(`${file} could not be started`);
		return child.pid;
	}

	async isAlive(pid: number): Promise<boolean> {
		if (!pid) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'EPERM';
		}
	}

	async signal(pid: number, name: 'SIGTERM' | 'SIGKILL'): Promise<void> {
		try {
			process.kill(pid, name);
		} catch {
			// already gone
		}
	}

	connect(port: number, address = '127.0.0.1'): Promise<Duplex> {
		return new Promise((resolve, reject) => {
			const socket = net.connect({ port, host: address });
			socket.once('connect', () => {
				socket.setNoDelay(true);
				resolve(socket);
			});
			socket.once('error', reject);
		});
	}

	connectSocket(socketPath: string): Promise<Duplex> {
		return new Promise((resolve, reject) => {
			const socket = net.connect({ path: socketPath });
			socket.once('connect', () => resolve(socket));
			socket.once('error', reject);
		});
	}

	processStartedAt(pid: number): Promise<number | undefined> {
		return processStartedAt(pid);
	}

	freePort(min?: number, max?: number, avoid?: ReadonlySet<number>): Promise<number> {
		return freeLocalPort(min, max, avoid);
	}

	async info(): Promise<HostInfo> {
		return {
			hostname: os.hostname(),
			cpus: os.cpus().length,
			memoryMB: Math.round(os.totalmem() / 1024 / 1024),
			availableMemoryMB: await availableMemoryMB(),
			cpuLoad: this.cpu.sample(),
			platform: `${os.platform()} ${os.arch()}`
		};
	}

	sampleProcess(pid: number): Promise<ProcessSample | undefined> {
		return sampleProcess(pid);
	}

	listProcesses(): Promise<ProcessEntry[]> {
		return listProcesses();
	}

	dispose(): void {}
}

export { sleepMs };
