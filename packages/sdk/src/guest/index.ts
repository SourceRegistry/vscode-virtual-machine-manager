/**
 * Working inside a guest through the QEMU guest agent (QGA), the same for every provider that can reach
 * one: QEMU over its agent socket, libvirt through `virsh qemu-agent-command`. A provider passes an
 * `AgentCall` that sends one QGA command and returns its `return` value; this module does the rest
 * (running programs, copying files). Node only, so a subpath (`@vmm/sdk/guest`).
 */
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError, type GuestCommand, type GuestCommandResult, type TransferProgress } from '../index';

/** Sends one guest agent command and returns its `return` value; rejects with the agent's error text. */
export type AgentCall = <T = unknown>(command: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

/** Turns a failed agent call into something the user can act on. */
export function explainAgentError(error: unknown): ProviderError {
	if (error instanceof ProviderError && error.code !== 'failed') return error;
	const raw = error instanceof Error ? error.message : String(error);
	// libvirt wraps every error the agent returns: "guest agent command failed: unable to execute QEMU agent
	// command 'guest-file-open': <the agent's own message>". That wrapper says nothing about the agent being gone.
	const text = raw.replace(/^(?:error:\s*)?(?:guest agent command failed:\s*)?unable to execute QEMU agent command '[^']*':\s*/i, '').trim();
	// The guest's own answer first: a missing file is not a missing agent.
	if (/No such file or directory/i.test(text)) return new ProviderError(`Not found in the guest: ${text}`, 'notFound');
	if (/Permission denied|Access is denied/i.test(text)) return new ProviderError(`The guest refused access: ${text}`, 'permission');
	if (/has been disabled|not allowed|blocked|is disabled|blacklist|allow-rpcs|block-rpcs/i.test(text)) {
		return new ProviderError(`The guest agent refuses this (${text}). Some distributions turn off running commands and file access in the agent's configuration (e.g. /etc/sysconfig/qemu-ga on RHEL).`, 'unsupported');
	}
	if (/not responding|not connected|No guest agent|timed out|didn't respond|connection (closed|failed)|agent is not available/i.test(text)) {
		return new ProviderError(`The guest agent does not answer (${text}). Install and start qemu-guest-agent in the guest; the machine also needs the agent channel.`, 'unavailable');
	}
	return new ProviderError(text || 'The guest agent failed', 'failed');
}

/** `windows` when the agent says so; anything else is treated as a POSIX system with /bin/sh. */
export async function guestOs(call: AgentCall): Promise<'windows' | 'posix'> {
	const info = await call<{ id?: string }>('guest-get-osinfo').catch(() => undefined);
	return info?.id === 'mswindows' ? 'windows' : 'posix';
}

interface ExecStatus {
	exited: boolean;
	exitcode?: number;
	signal?: number;
	'out-data'?: string;
	'err-data'?: string;
	'out-truncated'?: boolean;
	'err-truncated'?: boolean;
}

const decode = (b64: string | undefined): string => (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');

export interface RunOptions {
	/** Time between status polls (default 250 ms, growing to 1 s). */
	pollMs?: number;
	/** Replaced in tests. */
	sleep?: (ms: number) => Promise<unknown>;
}

/** Runs a program in the guest and waits for it, up to `command.timeoutMs` (default 60 s). */
export async function runInGuest(call: AgentCall, command: GuestCommand, options: RunOptions = {}): Promise<GuestCommandResult> {
	if (!command.command.trim()) throw new ProviderError('Give a command to run.', 'invalid');
	const sleep = options.sleep ?? delay;
	let path = command.command;
	let args = command.args ?? [];
	if (command.shell) {
		const windows = (await guestOs(call)) === 'windows';
		[path, args] = windows ? ['cmd.exe', ['/c', command.command]] : ['/bin/sh', ['-c', command.command]];
	}
	let pid: number;
	try {
		({ pid } = await call<{ pid: number }>('guest-exec', {
			path,
			arg: args,
			'capture-output': true,
			...(command.input !== undefined ? { 'input-data': Buffer.from(command.input, 'utf8').toString('base64') } : {})
		}));
	} catch (error) {
		throw explainAgentError(error);
	}
	const deadline = Date.now() + (command.timeoutMs ?? 60_000);
	let wait = options.pollMs ?? 250;
	for (;;) {
		let status: ExecStatus;
		try {
			status = await call<ExecStatus>('guest-exec-status', { pid });
		} catch (error) {
			throw explainAgentError(error);
		}
		if (status.exited) {
			return {
				...(status.exitcode !== undefined ? { exitCode: status.exitcode } : {}),
				...(status.signal !== undefined ? { signal: status.signal } : {}),
				stdout: decode(status['out-data']),
				stderr: decode(status['err-data']),
				truncated: !!(status['out-truncated'] || status['err-truncated']),
				timedOut: false
			};
		}
		if (Date.now() >= deadline) return { stdout: '', stderr: '', truncated: false, timedOut: true };
		await sleep(wait);
		wait = Math.min(wait * 2, 1000);
	}
}

export interface CopyOptions {
	/** Bytes per agent message (default 1 MiB; a transport with a small message limit passes less). */
	chunkSize?: number;
	onProgress?: (progress: TransferProgress) => void;
}

async function closeHandle(call: AgentCall, handle: number): Promise<void> {
	await call('guest-file-close', { handle }).catch(() => undefined);
}

/** Copies a file on this computer to `guestPath` (created or replaced). */
export async function copyToGuest(call: AgentCall, localPath: string, guestPath: string, options: CopyOptions = {}): Promise<void> {
	if (!guestPath.trim()) throw new ProviderError('Give the path in the guest.', 'invalid');
	const total = (await stat(localPath)).size;
	const chunkSize = options.chunkSize ?? 1024 * 1024;
	let handle: number;
	try {
		handle = await call<number>('guest-file-open', { path: guestPath, mode: 'wb' });
	} catch (error) {
		throw explainAgentError(error);
	}
	let done = 0;
	try {
		options.onProgress?.({ done, total });
		for await (const chunk of createReadStream(localPath, { highWaterMark: chunkSize })) {
			const buffer = chunk as Buffer;
			// The agent writes the whole buffer or fails; a short count means the guest ran out of room.
			const written = await call<{ count: number }>('guest-file-write', { handle, 'buf-b64': buffer.toString('base64') }, 60_000);
			if (written.count !== buffer.length) throw new ProviderError(`The guest wrote ${written.count} of ${buffer.length} bytes (is its disk full?).`, 'failed');
			done += buffer.length;
			options.onProgress?.({ done, total });
		}
		await call('guest-file-flush', { handle }).catch(() => undefined);
	} catch (error) {
		throw explainAgentError(error);
	} finally {
		await closeHandle(call, handle);
	}
}

/** Copies `guestPath` to a file on this computer, which only appears once the copy is complete. */
export async function copyFromGuest(call: AgentCall, guestPath: string, localPath: string, options: CopyOptions = {}): Promise<void> {
	if (!guestPath.trim()) throw new ProviderError('Give the path in the guest.', 'invalid');
	const chunkSize = options.chunkSize ?? 1024 * 1024;
	let handle: number;
	try {
		handle = await call<number>('guest-file-open', { path: guestPath, mode: 'rb' });
	} catch (error) {
		throw explainAgentError(error);
	}
	const part = `${localPath}.part`;
	const file = await open(part, 'w');
	let done = 0;
	try {
		// The size, for progress only: seek to the end and back.
		let total: number | undefined;
		try {
			total = (await call<{ position: number }>('guest-file-seek', { handle, offset: 0, whence: 'end' })).position;
			await call('guest-file-seek', { handle, offset: 0, whence: 'set' });
		} catch {
			total = undefined;
		}
		options.onProgress?.({ done, total });
		for (;;) {
			const read = await call<{ count: number; 'buf-b64'?: string; eof: boolean }>('guest-file-read', { handle, count: chunkSize }, 60_000);
			if (read.count) {
				const buffer = Buffer.from(read['buf-b64'] ?? '', 'base64');
				await file.write(buffer);
				done += buffer.length;
				options.onProgress?.({ done, total });
			}
			if (read.eof || !read.count) break;
		}
		await file.close();
		await rename(part, localPath);
	} catch (error) {
		await file.close().catch(() => undefined);
		await rm(part, { force: true }).catch(() => undefined);
		throw explainAgentError(error);
	} finally {
		await closeHandle(call, handle);
	}
}
