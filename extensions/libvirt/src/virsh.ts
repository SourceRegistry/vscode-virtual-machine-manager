import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import { ProviderError } from '@vmm/sdk';

export interface RunResult { stdout: string; stderr: string }
/** How a command is run; replaced in tests. */
export type Runner = (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv; input?: string }) => Promise<RunResult>;

export const execRunner: Runner = (file, args, options) =>
	new Promise((resolve, reject) => {
		const child = execFile(file, args, { timeout: options.timeout, env: options.env, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { stdout, stderr }));
			else resolve({ stdout, stderr });
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
	});

const WELL_KNOWN = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/opt/homebrew/sbin', '/usr/local/sbin'];

/** The virsh to run: the configured path, else the first one on PATH or in the usual install folders. */
export function findVirsh(configured?: string, exists: (file: string) => boolean = existsSync, pathEnv = process.env.PATH ?? ''): string | undefined {
	if (configured?.trim()) return exists(configured.trim()) ? configured.trim() : undefined;
	const name = process.platform === 'win32' ? 'virsh.exe' : 'virsh';
	for (const dir of [...pathEnv.split(delimiter), ...WELL_KNOWN]) {
		if (!dir) continue;
		const candidate = `${dir.replace(/[\\/]$/, '')}${process.platform === 'win32' ? '\\' : '/'}${name}`;
		if (exists(candidate)) return candidate;
	}
	return undefined;
}

/** Turns what virsh says into something a user can act on. */
export function explainVirshError(stderr: string, uri: string): ProviderError {
	const text = stderr.replace(/^error:\s*/gim, '').trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ');
	if (/Failed to connect socket|Connection refused|no such file or directory.*libvirt-sock|Failed to connect to the hypervisor/i.test(text) && !/Permission denied|authentication/i.test(text)) {
		return new ProviderError(`Could not connect to libvirt at ${uri}. ${/\+ssh/.test(uri) ? 'Check the SSH host, that libvirt runs there and that your user may use it.' : 'Is libvirt running? On Linux start libvirtd (or virtqemud); on macOS the session daemon starts by itself.'} (${text})`, 'unavailable');
	}
	if (/Permission denied|authentication failed|access denied|polkit|not authorized/i.test(text)) {
		return new ProviderError(`libvirt refused access (${text}). For qemu:///system add your user to the "libvirt" group, or use the user session.`, 'permission');
	}
	if (/Host key verification failed|REMOTE HOST IDENTIFICATION|ssh.*(exited|closed)|Cannot recv data|Connection closed|Could not resolve hostname|No route to host|Connection timed out/i.test(text)) {
		return new ProviderError(`The SSH connection failed (${text}). Connect once with ssh in a terminal to accept the host key, and use a key or the agent: virsh cannot ask for a password here.`, 'unavailable');
	}
	if (/Domain not found|failed to get domain|no domain with matching/i.test(text)) return new ProviderError(`The domain no longer exists (${text}).`, 'notFound');
	if (/not supported|unsupported|operation is not valid.*not (running|active)/i.test(text)) return new ProviderError(text, 'unsupported');
	return new ProviderError(text || 'virsh failed', 'failed');
}

export class Virsh {
	constructor(readonly binary: string, readonly uri: string, private readonly run: Runner = execRunner) {}

	private env(): NodeJS.ProcessEnv {
		// A GUI-started VS Code has a short PATH: virsh finds the session daemon through it. C locale: output is parsed.
		return { ...process.env, LC_ALL: 'C', LANG: 'C', PATH: [process.env.PATH, ...WELL_KNOWN].filter(Boolean).join(delimiter) };
	}

	/** Runs `virsh -c <uri> <args>` and returns stdout. */
	async exec(args: string[], timeoutMs = 30_000): Promise<string> {
		try {
			return (await this.run(this.binary, ['-c', this.uri, ...args], { timeout: timeoutMs, env: this.env() })).stdout;
		} catch (error) {
			const e = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
			if (e.code === 'ENOENT') throw new ProviderError(`virsh was not found at ${this.binary}.`, 'unavailable');
			if (e.killed) throw new ProviderError(`virsh did not answer within ${Math.round(timeoutMs / 1000)} seconds (${args[0]}).`, 'timeout');
			throw explainVirshError(e.stderr || e.message, this.uri);
		}
	}
}
