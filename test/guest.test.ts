import { describe, expect, it } from 'vitest';
import { defaultGuestPath, formatGuestRun, guestBaseName, guestRunStatus, transferText } from '../src/shared/guest';

const result = { stdout: 'Linux vm 6.12\n', stderr: 'a\nb\n', truncated: false, timedOut: false, exitCode: 0 };

describe('guest command text', () => {
	it('writes a transcript block: header, output, stderr marked, how it ended', () => {
		const text = formatGuestRun('web', 'uname -a', result, new Date(2026, 10, 12, 9, 5, 0));
		expect(text.split('\n')).toEqual([expect.stringMatching(/^\[.+\] web \$ uname -a$/), 'Linux vm 6.12', 'stderr: a', 'stderr: b', '— exit code 0', '']);
		expect(formatGuestRun('web', 'x', { ...result, stdout: '', stderr: '', truncated: true })).toContain('cut short');
	});
	it('says how a command ended', () => {
		expect(guestRunStatus({ ...result, exitCode: 2 })).toBe('— exit code 2');
		expect(guestRunStatus({ ...result, exitCode: undefined, signal: 9 })).toBe('— ended by signal 9');
		expect(guestRunStatus({ ...result, timedOut: true })).toContain('still running');
	});
	it('picks guest paths and names', () => {
		expect(defaultGuestPath('a.txt')).toBe('/tmp/a.txt');
		expect(defaultGuestPath('a.txt', true)).toBe('C:\\Users\\Public\\a.txt');
		expect(guestBaseName('/var/log/syslog')).toBe('syslog');
		expect(guestBaseName('C:\\Windows\\win.ini')).toBe('win.ini');
		expect(guestBaseName('/')).toBe('file');
	});
	it('describes progress', () => {
		expect(transferText({ done: 1.5 * 1024 * 1024, total: 4 * 1024 * 1024 })).toBe('1.5 of 4.0 MB');
		expect(transferText({ done: 0 })).toBe('0.0 MB');
	});
});
