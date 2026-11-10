import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	chooseSshTarget,
	findSshConfigBlock,
	listSshConfigBlocks,
	removeSshConfigBlock,
	hostAlias,
	nextPort,
	renderSshConfigBlock,
	upsertSshConfigBlock,
	usableAddress,
	validSshUser
} from '../src/shared/ssh';

const nic = (ipAddresses: string[] | undefined, extra: Record<string, unknown> = {}) => ({ id: 'nic0', label: 'NIC', ipAddresses, ...extra });

describe('usableAddress', () => {
	it('accepts routable IPv4', () => {
		for (const a of ['192.168.1.20', '10.0.2.15', '172.16.5.4', '8.8.8.8']) expect(usableAddress(a)).toBe(true);
	});

	it('rejects loopback, link-local, unspecified, IPv6 and junk', () => {
		for (const a of ['127.0.0.1', '169.254.3.4', '0.0.0.0', 'fe80::1', '::1', '300.1.1.1', 'host', '']) expect(usableAddress(a)).toBe(false);
	});
});

describe('chooseSshTarget', () => {
	it('prefers a forward to guest port 22, on the address a client on this computer connects to', () => {
		const target = chooseSshTarget({ nics: [nic(['192.168.1.20'])], forwards: [{ protocol: 'tcp', hostPort: 2222, guestPort: 22 }] });
		expect(target).toEqual({ host: '127.0.0.1', port: 2222, via: 'forward' });
	});

	it('turns a wildcard forward address into loopback and keeps a specific one', () => {
		expect(chooseSshTarget({ nics: [], forwards: [{ protocol: 'tcp', hostAddress: '0.0.0.0', hostPort: 2200, guestPort: 22 }] })?.host).toBe('127.0.0.1');
		expect(chooseSshTarget({ nics: [], forwards: [{ protocol: 'tcp', hostAddress: '192.168.1.5', hostPort: 2200, guestPort: 22 }] })?.host).toBe('192.168.1.5');
	});

	it('ignores UDP forwards and forwards to other guest ports', () => {
		const forwards = [
			{ protocol: 'udp' as const, hostPort: 2222, guestPort: 22 },
			{ protocol: 'tcp' as const, hostPort: 8080, guestPort: 80 }
		];
		expect(chooseSshTarget({ nics: [], forwards })).toBeUndefined();
	});

	it('falls back to an address of the VM that the host can reach', () => {
		expect(chooseSshTarget({ nics: [nic(['192.168.1.20'])], forwards: [] })).toEqual({ host: '192.168.1.20', port: 22, via: 'address' });
	});

	it('does not offer the NAT address of a guest that is not reachable', () => {
		expect(chooseSshTarget({ nics: [nic(['10.0.2.15'], { reachable: false })], forwards: [] })).toBeUndefined();
	});

	it('skips unusable addresses and unreachable adapters, and takes the first usable one', () => {
		const nics = [nic(['10.0.2.15'], { reachable: false }), nic(['fe80::1', '169.254.1.1']), nic(undefined), nic(['fe80::2', '192.168.5.9'])];
		expect(chooseSshTarget({ nics, forwards: [] })).toEqual({ host: '192.168.5.9', port: 22, via: 'address' });
	});

	it('has no target without a forward or an address', () => {
		expect(chooseSshTarget({ nics: [], forwards: [] })).toBeUndefined();
	});
});

describe('nextPort', () => {
	it('returns the start when free and skips taken ports', () => {
		expect(nextPort(2222, [])).toBe(2222);
		expect(nextPort(2222, [2222, 2223])).toBe(2224);
		expect(nextPort(2222, new Set([22, 2223]))).toBe(2222);
	});
});

describe('hostAlias', () => {
	it('is readable, stable for a VM, and different for VMs of the same name', () => {
		expect(hostAlias('Web Server 01', 'c1/n/100')).toMatch(/^vmm-web-server-01-[0-9a-f]{4}$/);
		expect(hostAlias('Web Server 01', 'c1/n/100')).toBe(hostAlias('Web Server 01', 'c1/n/100'));
		expect(hostAlias('web', 'c1/n/100')).not.toBe(hostAlias('web', 'c2/n/100'));
	});

	it('copes with names that are all symbols', () => {
		expect(hostAlias('()()', 'k')).toMatch(/^vmm-vm-[0-9a-f]{4}$/);
	});
});

describe('ssh config block', () => {
	const entry = { alias: 'vmm-web-1a2b', host: '127.0.0.1', port: 2222, user: 'alex', vmName: 'web (prod)' };
	const block = renderSshConfigBlock('c1/n/100', entry);

	it('renders a Host entry that keys known_hosts by the alias', () => {
		expect(block).toBe(
			[
				'# BEGIN VM Manager: c1/n/100',
				'# web (prod) (written by VM Manager; delete this block to forget it)',
				'Host vmm-web-1a2b',
				'  HostName 127.0.0.1',
				'  Port 2222',
				'  User alex',
				'  HostKeyAlias vmm-web-1a2b',
				'# END VM Manager: c1/n/100'
			].join('\n')
		);
	});

	it('appends to an empty file, a file with and without a trailing newline, leaving the rest untouched', () => {
		expect(upsertSshConfigBlock('', 'c1/n/100', block)).toBe(`${block}\n`);
		expect(upsertSshConfigBlock('Host a\n  User x\n', 'c1/n/100', block)).toBe(`Host a\n  User x\n\n${block}\n`);
		expect(upsertSshConfigBlock('Host a\n  User x', 'c1/n/100', block)).toBe(`Host a\n  User x\n\n${block}\n`);
		expect(upsertSshConfigBlock('Host a\n\n', 'c1/n/100', block)).toBe(`Host a\n\n${block}\n`);
	});

	it('replaces its own block in place and nothing else', () => {
		const before = `Host a\n  User x\n\n${block}\n\nHost b\n  User y\n`;
		const moved = renderSshConfigBlock('c1/n/100', { ...entry, port: 2299 });
		const after = upsertSshConfigBlock(before, 'c1/n/100', moved);
		expect(after).toBe(`Host a\n  User x\n\n${moved}\n\nHost b\n  User y\n`);
		expect(after.match(/BEGIN VM Manager/g)).toHaveLength(1);
		expect(findSshConfigBlock(after, 'c1/n/100')).toBe(moved);
	});

	it('keeps blocks of different VMs apart', () => {
		const other = renderSshConfigBlock('c1/n/101', { ...entry, alias: 'vmm-db-3c4d', port: 2223 });
		const both = upsertSshConfigBlock(upsertSshConfigBlock('', 'c1/n/100', block), 'c1/n/101', other);
		expect(findSshConfigBlock(both, 'c1/n/100')).toBe(block);
		expect(findSshConfigBlock(both, 'c1/n/101')).toBe(other);
		expect(findSshConfigBlock(both, 'c1/n/102')).toBeUndefined();
	});

	it('treats a block without its end marker as absent instead of eating the file', () => {
		const broken = 'Host a\n# BEGIN VM Manager: c1/n/100\nHost b\n';
		expect(findSshConfigBlock(broken, 'c1/n/100')).toBeUndefined();
		expect(upsertSshConfigBlock(broken, 'c1/n/100', block)).toBe(`${broken}\n${block}\n`);
	});

	it('refuses values that could inject config lines', () => {
		for (const user of ['a b', 'a\nHost evil', '-oProxyCommand=x', '', 'a'.repeat(65)]) {
			expect(() => renderSshConfigBlock('k', { ...entry, user })).toThrow();
		}
		expect(() => renderSshConfigBlock('k', { ...entry, host: '1.2.3.4\nProxyCommand x' })).toThrow();
		expect(() => renderSshConfigBlock('k', { ...entry, port: 0 })).toThrow();
		expect(() => renderSshConfigBlock('k', { ...entry, port: 70000 })).toThrow();
		expect(() => renderSshConfigBlock('k', { ...entry, alias: 'a b' })).toThrow();
		expect(() => renderSshConfigBlock('k\nHost evil', entry)).toThrow();
	});

	it('flattens a VM name with line breaks into the comment', () => {
		expect(renderSshConfigBlock('k', { ...entry, vmName: 'a\nHost evil' }).split('\n')).toHaveLength(8);
	});
});

describe('validSshUser', () => {
	it('accepts ordinary account names and refuses option-like or spaced ones', () => {
		for (const user of ['alex', 'debian', 'root', 'a.b_c-d', 'user1']) expect(validSshUser(user)).toBe(true);
		for (const user of ['', '-x', 'a b', 'a@b', 'a/b']) expect(validSshUser(user)).toBe(false);
	});
});

describe('listing and removing blocks', () => {
	const entry = (alias: string, port: number, user = 'alex', vmName = 'web') => ({ alias, host: '127.0.0.1', port, user, vmName });
	const a = renderSshConfigBlock('c/n/1', entry('vmm-web-1111', 2222, 'alex', 'web (prod)'));
	const b = renderSshConfigBlock('c/n/2', entry('vmm-db-2222', 2223, 'root', 'db'));

	it('lists what each block says, in file order, ignoring the rest of the file', () => {
		const text = `Host mine\n  HostName example.com\n  Port 22\n\n${a}\n\nHost other\n  Port 99\n\n${b}\n`;
		expect(listSshConfigBlocks(text)).toEqual([
			{ key: 'c/n/1', alias: 'vmm-web-1111', host: '127.0.0.1', port: 2222, user: 'alex', name: 'web (prod)' },
			{ key: 'c/n/2', alias: 'vmm-db-2222', host: '127.0.0.1', port: 2223, user: 'root', name: 'db' }
		]);
	});

	it('lists nothing for a file without blocks or with a block that was cut off', () => {
		expect(listSshConfigBlocks('Host a\n  Port 1\n')).toEqual([]);
		expect(listSshConfigBlocks('# BEGIN VM Manager: c/n/1\nHost x\n')).toEqual([]);
		expect(listSshConfigBlocks('')).toEqual([]);
	});

	it('gives the original file back after adding and removing, whatever surrounds the block', () => {
		for (const original of ['', 'Host a\n  User x\n', 'Host a\n  User x', 'Host a\n\n', 'Host a\n\nHost b\n  User y\n']) {
			const added = upsertSshConfigBlock(original, 'c/n/1', a);
			const removed = removeSshConfigBlock(added, 'c/n/1');
			expect(removed.trimEnd()).toBe(original.trimEnd());
		}
	});

	it('removes a block from the middle without leaving a double blank line, and only that block', () => {
		const text = `Host a\n\n${a}\n\n${b}\n\nHost z\n`;
		expect(removeSshConfigBlock(text, 'c/n/1')).toBe(`Host a\n\n${b}\n\nHost z\n`);
		expect(removeSshConfigBlock(text, 'c/n/2')).toBe(`Host a\n\n${a}\n\nHost z\n`);
	});

	it('removes a block at the start or the end', () => {
		expect(removeSshConfigBlock(`${a}\n\nHost z\n`, 'c/n/1')).toBe('Host z\n');
		expect(removeSshConfigBlock(`Host z\n\n${a}\n`, 'c/n/1')).toBe('Host z\n');
		expect(removeSshConfigBlock(`${a}\n`, 'c/n/1')).toBe('');
	});

	it('leaves the file alone for an unknown key or a cut-off block', () => {
		expect(removeSshConfigBlock(`Host a\n\n${a}\n`, 'c/n/9')).toBe(`Host a\n\n${a}\n`);
		const cut = '# BEGIN VM Manager: c/n/1\nHost x\n';
		expect(removeSshConfigBlock(cut, 'c/n/1')).toBe(cut);
	});
});

describe('the ssh client reads the block as intended', () => {
	const hasSsh = (() => {
		try {
			execFileSync('ssh', ['-V'], { stdio: 'ignore' });
			return true;
		} catch {
			return false;
		}
	})();

	it.skipIf(!hasSsh)('resolves the alias to the host, port, user and host key alias (ssh -G)', () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'vmm-ssh-'));
		try {
			const file = path.join(dir, 'config');
			const block = renderSshConfigBlock('c/n/1', { alias: 'vmm-web-1111', host: '127.0.0.1', port: 2222, user: 'alex', vmName: 'web' });
			writeFileSync(file, upsertSshConfigBlock('Host other\n  Port 99\n', 'c/n/1', block));
			const resolved = Object.fromEntries(
				execFileSync('ssh', ['-G', '-F', file, 'vmm-web-1111'], { encoding: 'utf8' })
					.split('\n')
					.map((line) => line.split(' ') as [string, ...string[]])
					.map(([k, ...v]) => [k, v.join(' ')])
			);
			expect(resolved).toMatchObject({ hostname: '127.0.0.1', port: '2222', user: 'alex', hostkeyalias: 'vmm-web-1111' });
			// The alias is the only thing that matches: another host name still gets the defaults.
			const other = execFileSync('ssh', ['-G', '-F', file, 'something-else'], { encoding: 'utf8' });
			expect(other).toMatch(/^port 22$/m);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
