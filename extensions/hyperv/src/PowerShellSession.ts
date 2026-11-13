import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '@vmm/sdk';

const MARKER = /<<VMM:(\d+):(OK|ERR):([A-Za-z0-9+/=]*)>>/;
const MODE_MARKER = /<<VMM:MODE:(\w+)>>/;

interface Pending {
	id: number;
	resolve: (value: unknown[]) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class PowerShellError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PowerShellError';
	}
}

/**
 * A long-lived `powershell.exe` process that executes one script at a time.
 *
 * Scripts and parameters are transported base64 encoded and the parameters are only ever
 * available to the script as the deserialized `$p` object — user input is never interpolated
 * into script text. Results are returned as JSON (always an array) framed by markers so
 * stray output (warnings, Write-Host) cannot corrupt the protocol.
 */
export class PowerShellSession {
	private process: ChildProcessWithoutNullStreams | undefined;
	private buffer = '';
	private nextId = 1;
	private current: Pending | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;
	/** Set when PowerShell reports a language mode the framing cannot run in. */
	private blocked: PowerShellError | undefined;

	constructor(
		private readonly name: string,
		private readonly log?: Logger,
		private readonly executable = 'powershell.exe',
		/** A line run when the process starts, before anything else (tests use it to switch the language mode). */
		private readonly prelude = ''
	) {}

	/** Runs `script` with `params` bound to `$p`; resolves with the pipeline output as an array. */
	run<T = unknown>(script: string, params: unknown = {}, timeoutMs = 60_000): Promise<T[]> {
		this.pending++;
		const task = this.queue.then(() => this.execute(script, params, timeoutMs)).finally(() => this.pending--);
		this.queue = task.catch(() => undefined);
		return task as Promise<T[]>;
	}

	private pending = 0;

	/** A script is running or queued (calls run one after another). */
	get busy(): boolean {
		return this.pending > 0;
	}

	/** Like `run` but returns the first output object (or undefined). */
	async first<T = unknown>(script: string, params: unknown = {}, timeoutMs?: number): Promise<T | undefined> {
		const result = await this.run<T>(script, params, timeoutMs);
		return result[0];
	}

	private ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.disposed) throw new PowerShellError('PowerShell session disposed');
		if (this.process && this.process.exitCode === null && !this.process.killed) return this.process;

		const child = spawn(
			this.executable,
			['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
			{ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
		);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		child.stderr.on('data', (chunk: string) => this.log?.debug(`[ps:${this.name}] ${chunk.trim()}`));
		child.on('error', (error) => this.fail(new PowerShellError(`PowerShell could not be started: ${error.message}`)));
		child.on('exit', (code) => {
			if (this.process === child) this.process = undefined;
			this.fail(new PowerShellError(`PowerShell exited unexpectedly (code ${code})`));
		});
		child.stdin.write(
			"$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; $WarningPreference = 'SilentlyContinue'; $InformationPreference = 'SilentlyContinue'\n"
		);
		// Under an AppLocker / WDAC policy PowerShell runs in ConstrainedLanguage mode, which blocks the .NET calls the
		// command framing needs: every command would only time out. Say so instead (plain strings work in that mode).
		if (this.prelude) child.stdin.write(`${this.prelude}\n`);
		child.stdin.write("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { '<<VMM:MODE:' + $ExecutionContext.SessionState.LanguageMode + '>>' }\n");
		this.process = child;
		this.buffer = '';
		this.blocked = undefined;
		this.log?.debug(`[ps:${this.name}] started (pid ${child.pid})`);
		return child;
	}

	private execute(script: string, params: unknown, timeoutMs: number): Promise<unknown[]> {
		return new Promise((resolve, reject) => {
			let child: ChildProcessWithoutNullStreams;
			try {
				child = this.ensureProcess();
			} catch (error) {
				reject(error);
				return;
			}
			if (this.blocked) {
				reject(this.blocked);
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				if (this.current?.id !== id) return;
				this.log?.warn(`[ps:${this.name}] command ${id} timed out after ${timeoutMs} ms, restarting session`);
				this.current = undefined;
				reject(new PowerShellError('The PowerShell command timed out'));
				this.kill();
			}, timeoutMs);
			this.current = { id, resolve, reject, timer };
			child.stdin.write(buildCommand(id, script, params));
		});
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			const mode = MODE_MARKER.exec(line);
			if (mode) {
				this.blocked = new PowerShellError(
					`PowerShell runs in ${mode[1]} mode on this computer (set by an AppLocker or Windows Defender Application Control policy). ` +
						'That mode blocks what VM Manager needs to talk to Hyper-V; ask your administrator to allow full language mode for PowerShell, or use Hyper-V Manager.'
				);
				this.fail(this.blocked);
				continue;
			}
			const match = MARKER.exec(line);
			if (!match) {
				if (line) this.log?.debug(`[ps:${this.name}] ${line}`);
				continue;
			}
			const id = Number(match[1]);
			const pending = this.current;
			if (!pending || pending.id !== id) continue;
			this.current = undefined;
			clearTimeout(pending.timer);
			const payload = Buffer.from(match[3], 'base64').toString('utf8');
			if (match[2] === 'ERR') {
				pending.reject(new PowerShellError(payload.trim() || 'PowerShell command failed'));
				continue;
			}
			try {
				const parsed: unknown = payload ? JSON.parse(payload) : [];
				pending.resolve((Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item !== null));
			} catch (error) {
				pending.reject(new PowerShellError(`Invalid PowerShell output: ${(error as Error).message}`));
			}
		}
	}

	private fail(error: Error): void {
		const pending = this.current;
		this.current = undefined;
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}

	private kill(): void {
		const child = this.process;
		this.process = undefined;
		if (child && child.exitCode === null) child.kill();
	}

	dispose(): void {
		this.disposed = true;
		this.fail(new PowerShellError('PowerShell session disposed'));
		this.kill();
	}
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** One physical line: PowerShell's `-Command -` executes stdin line by line. */
export function buildCommand(id: number, script: string, params: unknown): string {
	const body = b64(`param($p)\n${script}`);
	const json = b64(JSON.stringify(params ?? {}));
	return (
		`try { ` +
		`$__p = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json}'))); ` +
		`$__sb = [ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body}'))); ` +
		`$__r = @(& $__sb $__p); ` +
		`$__j = ConvertTo-Json -InputObject $__r -Depth 6 -Compress; ` +
		`if ($null -eq $__j) { $__j = '[]' }; ` +
		`[Console]::Out.WriteLine('<<VMM:${id}:OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__j)) + '>>') ` +
		`} catch { ` +
		`[Console]::Out.WriteLine('<<VMM:${id}:ERR:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message)) + '>>') ` +
		`}\n`
	);
}
