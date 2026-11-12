/** Text for guest commands and copies (output channel, prompts). Pure, unit tested. */
import type { GuestCommandResult, TransferProgress } from '@vmm/sdk';

/** The block written to the output channel for one command: a header, its output, how it ended. */
export function formatGuestRun(vmName: string, command: string, result: GuestCommandResult, at: Date = new Date()): string {
	const lines = [`[${at.toLocaleTimeString()}] ${vmName} $ ${command}`];
	const body = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text);
	if (result.stdout) lines.push(body(result.stdout));
	if (result.stderr) lines.push(...body(result.stderr).split('\n').map((l) => `stderr: ${l}`));
	if (result.truncated) lines.push('(output cut short by the guest agent)');
	lines.push(guestRunStatus(result), '');
	return lines.join('\n');
}

/** One line on how a command ended. */
export function guestRunStatus(result: GuestCommandResult): string {
	if (result.timedOut) return '— still running in the guest; stopped waiting for it';
	if (result.signal !== undefined) return `— ended by signal ${result.signal}`;
	return `— exit code ${result.exitCode ?? 'unknown'}`;
}

/** Where a copied file lands in the guest when the user does not say: next to the user's files on Windows, /tmp elsewhere. */
export function defaultGuestPath(fileName: string, windows = false): string {
	return windows ? `C:\\Users\\Public\\${fileName}` : `/tmp/${fileName}`;
}

/** The last part of a guest path, POSIX or Windows. */
export function guestBaseName(guestPath: string): string {
	return guestPath.split(/[\\/]/).filter(Boolean).pop() ?? 'file';
}

/** `12.3 of 40.0 MB` / `12.3 MB`, for a progress message. */
export function transferText(progress: TransferProgress): string {
	const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
	return progress.total ? `${mb(progress.done)} of ${mb(progress.total)} MB` : `${mb(progress.done)} MB`;
}
