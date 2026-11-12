import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyFromGuest, copyToGuest, explainAgentError, runInGuest, type AgentCall } from '../src/guest';

/** A guest agent with an in-memory file system and scripted programs, speaking QGA's command shapes. */
function fakeAgent(options: { os?: string; exec?: (path: string, args: string[], input?: string) => { exitcode?: number; signal?: number; out?: string; err?: string; polls?: number }; fail?: Record<string, string> } = {}) {
	const files = new Map<string, Buffer>();
	const handles = new Map<number, { path: string; pos: number; write: boolean }>();
	const procs = new Map<number, { result: ReturnType<NonNullable<typeof options.exec>>; polls: number }>();
	const calls: Array<[string, Record<string, unknown> | undefined]> = [];
	let next = 1000;
	const call: AgentCall = async <T,>(command: string, args?: Record<string, unknown>) => {
		calls.push([command, args]);
		if (options.fail?.[command]) throw new Error(options.fail[command]);
		const a = args ?? {};
		const out = ((): unknown => {
			switch (command) {
				case 'guest-get-osinfo': return { id: options.os ?? 'debian' };
				case 'guest-exec': {
					const input = a['input-data'] ? Buffer.from(String(a['input-data']), 'base64').toString() : undefined;
					const result = options.exec!(String(a.path), a.arg as string[], input);
					const pid = next++;
					procs.set(pid, { result, polls: result.polls ?? 1 });
					return { pid };
				}
				case 'guest-exec-status': {
					const p = procs.get(Number(a.pid))!;
					if (p.polls-- > 0) return { exited: false };
					return {
						exited: true,
						...(p.result.exitcode !== undefined ? { exitcode: p.result.exitcode } : {}),
						...(p.result.signal !== undefined ? { signal: p.result.signal } : {}),
						...(p.result.out ? { 'out-data': Buffer.from(p.result.out).toString('base64') } : {}),
						...(p.result.err ? { 'err-data': Buffer.from(p.result.err).toString('base64') } : {})
					};
				}
				case 'guest-file-open': {
					const write = String(a.mode).startsWith('w');
					if (!write && !files.has(String(a.path))) throw new Error(`failed to open file '${a.path}': No such file or directory`);
					if (write) files.set(String(a.path), Buffer.alloc(0));
					const h = next++;
					handles.set(h, { path: String(a.path), pos: 0, write });
					return h;
				}
				case 'guest-file-write': {
					const h = handles.get(Number(a.handle))!;
					const data = Buffer.from(String(a['buf-b64']), 'base64');
					files.set(h.path, Buffer.concat([files.get(h.path)!, data]));
					return { count: data.length, eof: false };
				}
				case 'guest-file-seek': {
					const h = handles.get(Number(a.handle))!;
					h.pos = a.whence === 'end' ? files.get(h.path)!.length + Number(a.offset) : Number(a.offset);
					return { position: h.pos, eof: false };
				}
				case 'guest-file-read': {
					const h = handles.get(Number(a.handle))!;
					const data = files.get(h.path)!.subarray(h.pos, h.pos + Number(a.count));
					h.pos += data.length;
					return { count: data.length, 'buf-b64': data.toString('base64'), eof: h.pos >= files.get(h.path)!.length };
				}
				case 'guest-file-flush': return {};
				case 'guest-file-close': handles.delete(Number(a.handle)); return {};
				default: throw new Error(`The command ${command} has not been found`);
			}
		})();
		return out as T;
	};
	return { call, calls, files, handles };
}

const noSleep = { sleep: async () => undefined };

describe('runInGuest', () => {
	it('runs a shell command line through /bin/sh and decodes the output', async () => {
		const agent = fakeAgent({ exec: (path, args, input) => ({ exitcode: 3, out: `${path} ${args.join('|')} ${input ?? ''}`, err: 'warn\n', polls: 2 }) });
		const result = await runInGuest(agent.call, { command: 'echo hi && exit 3', shell: true, input: 'stdin' }, noSleep);
		expect(result).toEqual({ exitCode: 3, stdout: '/bin/sh -c|echo hi && exit 3 stdin', stderr: 'warn\n', truncated: false, timedOut: false });
		expect(agent.calls.filter(([c]) => c === 'guest-exec-status')).toHaveLength(3);
	});
	it('uses cmd.exe on Windows guests and runs a program with arguments as is', async () => {
		const agent = fakeAgent({ os: 'mswindows', exec: (path, args) => ({ exitcode: 0, out: `${path} ${args.join('|')}` }) });
		expect((await runInGuest(agent.call, { command: 'dir C:\\', shell: true }, noSleep)).stdout).toBe('cmd.exe /c|dir C:\\');
		expect((await runInGuest(agent.call, { command: '/usr/bin/id', args: ['-u'] }, noSleep)).stdout).toBe('/usr/bin/id -u');
	});
	it('reports a program that does not finish in time, and one ended by a signal', async () => {
		const slow = fakeAgent({ exec: () => ({ exitcode: 0, polls: 1_000_000 }) });
		expect(await runInGuest(slow.call, { command: 'sleep 999', shell: true, timeoutMs: 0 }, noSleep)).toMatchObject({ timedOut: true });
		const killed = fakeAgent({ exec: () => ({ signal: 9 }) });
		expect(await runInGuest(killed.call, { command: 'x', shell: true }, noSleep)).toMatchObject({ signal: 9, timedOut: false });
	});
	it('explains an agent that is missing or refuses', async () => {
		const missing = fakeAgent({ fail: { 'guest-exec': 'Guest agent is not responding: QEMU guest agent is not connected' } });
		await expect(runInGuest(missing.call, { command: 'x', shell: true }, noSleep)).rejects.toMatchObject({ code: 'unavailable' });
		const blocked = fakeAgent({ fail: { 'guest-exec': 'Command guest-exec has been disabled' } });
		await expect(runInGuest(blocked.call, { command: 'x', shell: true }, noSleep)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('qemu-ga') });
		await expect(runInGuest(missing.call, { command: '  ' }, noSleep)).rejects.toMatchObject({ code: 'invalid' });
	});
});

describe('copying files', () => {
	const dir = mkdtempSync(join(tmpdir(), 'vmm-guest-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const content = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));

	it('copies a file to the guest in chunks, with progress, and closes the handle', async () => {
		const agent = fakeAgent();
		const local = join(dir, 'up.bin');
		writeFileSync(local, content);
		const progress: number[] = [];
		await copyToGuest(agent.call, local, '/tmp/up.bin', { chunkSize: 4096, onProgress: (p) => progress.push(p.done) });
		expect(agent.files.get('/tmp/up.bin')!.equals(content)).toBe(true);
		expect(agent.calls.filter(([c]) => c === 'guest-file-write')).toHaveLength(3);
		expect(progress).toEqual([0, 4096, 8192, 10_000]);
		expect(agent.handles.size).toBe(0);
	});
	it('copies a file from the guest, and only then creates the local file', async () => {
		const agent = fakeAgent();
		agent.files.set('/var/log/x', content);
		const local = join(dir, 'down.bin');
		const progress: Array<number | undefined> = [];
		await copyFromGuest(agent.call, '/var/log/x', local, { chunkSize: 3000, onProgress: (p) => progress.push(p.total) });
		expect(readFileSync(local).equals(content)).toBe(true);
		expect(existsSync(`${local}.part`)).toBe(false);
		expect(progress.every((t) => t === 10_000)).toBe(true);
		expect(agent.handles.size).toBe(0);
	});
	it('leaves nothing behind when the guest file is missing or the read fails', async () => {
		const missing = fakeAgent();
		const local = join(dir, 'none.bin');
		await expect(copyFromGuest(missing.call, '/nope', local)).rejects.toMatchObject({ message: expect.stringContaining('No such file') });
		const broken = fakeAgent({ fail: { 'guest-file-read': 'Guest agent is not responding' } });
		broken.files.set('/x', content);
		await expect(copyFromGuest(broken.call, '/x', local)).rejects.toMatchObject({ code: 'unavailable' });
		expect(existsSync(local) || existsSync(`${local}.part`)).toBe(false);
		expect(broken.handles.size).toBe(0);
	});
	it('maps unknown failures to a plain failure', () => {
		expect(explainAgentError(new Error('boom'))).toMatchObject({ code: 'failed', message: 'boom' });
	});
	it('reads past libvirt\'s wrapper: a missing file is not a missing agent', () => {
		// Exactly what libvirt 12.9 said for a file Debian 13 does not have.
		const missing = explainAgentError(new Error("guest agent command failed: unable to execute QEMU agent command 'guest-file-open': failed to open file '/var/log/syslog' (mode: 'rb'): No such file or directory"));
		expect(missing).toMatchObject({ code: 'notFound', message: "Not found in the guest: failed to open file '/var/log/syslog' (mode: 'rb'): No such file or directory" });
		expect(explainAgentError(new Error("unable to execute QEMU agent command 'guest-file-open': failed to open file '/root/x' (mode: 'rb'): Permission denied"))).toMatchObject({ code: 'permission' });
		expect(explainAgentError(new Error("guest agent command timed out: guest agent didn't respond to command within '60' seconds"))).toMatchObject({ code: 'unavailable' });
		expect(explainAgentError(new Error('Guest agent is not responding: QEMU guest agent is not connected'))).toMatchObject({ code: 'unavailable' });
	});
});
