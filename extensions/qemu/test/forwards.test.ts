import { describe, expect, it } from 'vitest';
import { addCommand, forwardRule, hmpError, hostfwdOptions, removeCommand, sameHostSocket, validateForward } from '../src/forwards';

const ssh = { protocol: 'tcp' as const, hostPort: 2222, guestPort: 22 };

describe('forwards', () => {
	it('spells the rule with a loopback default', () => {
		expect(forwardRule(ssh)).toBe('tcp:127.0.0.1:2222-:22');
		expect(forwardRule({ ...ssh, protocol: 'udp', hostAddress: '0.0.0.0' })).toBe('udp:0.0.0.0:2222-:22');
	});

	it('builds -nic options and monitor commands', () => {
		expect(hostfwdOptions([ssh, { protocol: 'tcp', hostPort: 8080, guestPort: 80 }])).toBe(',hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:8080-:80');
		expect(hostfwdOptions(undefined)).toBe('');
		expect(addCommand(ssh)).toBe('hostfwd_add tcp:127.0.0.1:2222-:22');
		expect(removeCommand(ssh)).toBe('hostfwd_remove tcp:127.0.0.1:2222');
	});

	it('validates ports, protocol and address', () => {
		expect(validateForward(ssh)).toBeUndefined();
		expect(validateForward({ ...ssh, hostPort: 0 })).toMatch(/Host port/);
		expect(validateForward({ ...ssh, guestPort: 70000 })).toMatch(/Guest port/);
		expect(validateForward({ ...ssh, hostPort: 22.5 })).toMatch(/Host port/);
		expect(validateForward({ ...ssh, protocol: 'icmp' as 'tcp' })).toMatch(/Protocol/);
		expect(validateForward({ ...ssh, hostAddress: 'localhost; quit' })).toMatch(/address/);
	});

	it('detects the same host socket regardless of the default address', () => {
		expect(sameHostSocket(ssh, { ...ssh, hostAddress: '127.0.0.1', guestPort: 2200 })).toBe(true);
		expect(sameHostSocket(ssh, { ...ssh, protocol: 'udp' })).toBe(false);
		expect(sameHostSocket(ssh, { ...ssh, hostAddress: '0.0.0.0' })).toBe(false);
	});

	it('treats any HMP output as an error', () => {
		expect(hmpError('')).toBeUndefined();
		expect(hmpError(undefined)).toBeUndefined();
		expect(hmpError('invalid format\r\n')).toBe('invalid format');
	});
});
