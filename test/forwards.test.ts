import { describe, expect, it } from 'vitest';
import { browserUrl, sshCommand } from '../src/shared/forwards';

const ssh = { protocol: 'tcp' as const, hostPort: 2222, guestPort: 22 };

describe('forward actions', () => {
	it('offers ssh only for guest port 22 over tcp', () => {
		expect(sshCommand(ssh)).toBe('ssh -p 2222 127.0.0.1');
		expect(sshCommand({ ...ssh, guestPort: 2200 })).toBeUndefined();
		expect(sshCommand({ ...ssh, protocol: 'udp' })).toBeUndefined();
		expect(sshCommand({ ...ssh, hostAddress: '0.0.0.0' })).toBe('ssh -p 2222 127.0.0.1');
	});

	it('offers a URL only for web ports', () => {
		expect(browserUrl({ protocol: 'tcp', hostPort: 8080, guestPort: 80 })).toBe('http://127.0.0.1:8080/');
		expect(browserUrl({ protocol: 'tcp', hostPort: 8443, guestPort: 443 })).toBe('https://127.0.0.1:8443/');
		expect(browserUrl(ssh)).toBeUndefined();
	});
});
