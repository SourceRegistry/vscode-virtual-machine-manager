import { describe, expect, it } from 'vitest';
import type { VmInfo } from '@vmm/sdk';
import { matchesQuery } from '../src/shared/vmSearch';

const vm: VmInfo = { id: 'a1', displayId: '105', name: 'Web Server', state: 'running', ipAddresses: ['192.168.1.20'], macAddresses: ['BC:24:11:AA:BB:CC'] };

describe('VM search', () => {
	it('matches name, id, IP and MAC', () => {
		expect(matchesQuery('web', vm)).toBe(true);
		expect(matchesQuery('105', vm)).toBe(true);
		expect(matchesQuery('192.168.1', vm)).toBe(true);
		expect(matchesQuery('bc:24:11', vm)).toBe(true);
		expect(matchesQuery('nope', vm)).toBe(false);
	});

	it('finds a MAC however the separators are written', () => {
		expect(matchesQuery('bc2411aabbcc', vm)).toBe(true);
		expect(matchesQuery('bc-24-11-aa-bb-cc', vm)).toBe(true);
		expect(matchesQuery('BC24.11AA', vm)).toBe(true);
	});

	it('needs every word, and an empty query matches everything', () => {
		expect(matchesQuery('web 192.168', vm)).toBe(true);
		expect(matchesQuery('web 10.0', vm)).toBe(false);
		expect(matchesQuery('  ', vm)).toBe(true);
	});

	it('also matches the cluster and node it lives on', () => {
		expect(matchesQuery('prod', vm, ['Production', 'pve1'])).toBe(true);
		expect(matchesQuery('prod', vm)).toBe(false);
	});

	it('takes #<id> as an id prefix, alone or combined with an address', () => {
		expect(matchesQuery('#105', vm)).toBe(true);
		expect(matchesQuery('#10', vm)).toBe(true);
		expect(matchesQuery('#5', vm)).toBe(false);
		expect(matchesQuery('#', vm)).toBe(true);
		expect(matchesQuery('#105 192.168.1.20', vm)).toBe(true);
		expect(matchesQuery('#106 192.168.1.20', vm)).toBe(false);
	});

	it('finds a full IP, and does not mistake an IP for a MAC', () => {
		expect(matchesQuery('192.168.1.20', vm)).toBe(true);
		expect(matchesQuery('192.168.1.21', vm)).toBe(false);
		expect(matchesQuery('192.168.1', { ...vm, ipAddresses: [], macAddresses: ['AA:19:21:68:10:00'] })).toBe(false);
	});
});
