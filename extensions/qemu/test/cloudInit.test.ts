import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cloudInitProblem, hostnameFor, metaData, sha512Crypt, userData, validCloudUser, validHostname, validSshPublicKey } from '../src/cloudInit';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop';

describe('sha512Crypt', () => {
	it('matches the published test vectors', () => {
		// Drepper, "Unix crypt using SHA-256 and SHA-512".
		expect(sha512Crypt('Hello world!', 'saltstring')).toBe('$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
		expect(sha512Crypt('This is just a test', 'toolongsaltstring')).toBe('$6$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0');
	});
	it('agrees with the system crypt when openssl can do SHA-512', () => {
		let reference: string;
		try {
			reference = execFileSync('openssl', ['passwd', '-6', '-salt', 'abcdefgh', 'correct horse'], { encoding: 'utf8' }).trim();
		} catch {
			return;
		}
		if (!reference.startsWith('$6$')) return;
		expect(sha512Crypt('correct horse', 'abcdefgh')).toBe(reference);
	});
	it('handles empty, long and non-ASCII passwords, and picks a fresh salt', () => {
		for (const password of ['', 'x'.repeat(200), 'pässwörd ✓']) expect(sha512Crypt(password, 'salt1234')).toMatch(/^\$6\$salt1234\$[./0-9A-Za-z]{86}$/);
		const a = sha512Crypt('same');
		const b = sha512Crypt('same');
		expect(a).not.toBe(b);
		expect(a).toMatch(/^\$6\$[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$/);
	});
});

describe('validation', () => {
	it('checks user names, host names and keys', () => {
		expect(validCloudUser('alex')).toBe(true);
		expect(validCloudUser('dev_ops-1')).toBe(true);
		for (const bad of ['', 'Root', 'root', '1abc', 'a b', 'a:b', 'x'.repeat(40), 'a\nb']) expect(validCloudUser(bad), bad).toBe(false);
		expect(validHostname('web-01')).toBe(true);
		for (const bad of ['', '-a', 'a-', 'a_b', 'A', 'a.b', 'x'.repeat(64)]) expect(validHostname(bad), bad).toBe(false);
		expect(validSshPublicKey(KEY)).toBe(true);
		expect(validSshPublicKey('ecdsa-sha2-nistp256 AAAAE2Vj')).toBe(true);
		for (const bad of ['', 'not a key', 'ssh-ed25519', 'ssh-ed25519 AAAA\nssh-ed25519 BBBB', 'PRIVATE KEY']) expect(validSshPublicKey(bad), bad).toBe(false);
	});
	it('turns a VM name into a host name', () => {
		expect(hostnameFor('My Web Server!')).toBe('my-web-server');
		expect(hostnameFor('___')).toBe('vm');
		expect(validHostname(hostnameFor('a'.repeat(100) + '--'))).toBe(true);
	});
	it('needs a way to sign in', () => {
		const base = { hostname: 'h', user: 'u', sshKeys: [] as string[], passwordHash: undefined };
		expect(cloudInitProblem({ ...base })).toMatch(/no way to sign in/);
		expect(cloudInitProblem({ ...base, sshKeys: [KEY] })).toBeUndefined();
		expect(cloudInitProblem({ ...base, passwordHash: sha512Crypt('x', 'salt') })).toBeUndefined();
		expect(cloudInitProblem({ ...base, sshKeys: ['junk'] })).toMatch(/not a public key/);
		expect(cloudInitProblem({ ...base, passwordHash: 'plain', sshKeys: [KEY] })).toMatch(/hash/);
		expect(cloudInitProblem({ ...base, hostname: 'Bad_Name', sshKeys: [KEY] })).toMatch(/host name/);
	});
});

describe('user-data and meta-data', () => {
	const opts = { hostname: 'web-01', user: 'alex', sshKeys: [KEY], installAgent: true, instanceId: 'vmm-abc' };

	it('creates the user with a key, passwordless sudo and the guest agent', () => {
		const text = userData(opts);
		expect(text.startsWith('#cloud-config\n')).toBe(true);
		expect(text).toContain('hostname: "web-01"');
		expect(text).toContain('  - name: "alex"');
		expect(text).toContain('sudo: "ALL=(ALL) NOPASSWD:ALL"');
		expect(text).toContain('lock_passwd: true');
		expect(text).toContain(`      - "${KEY}"`);
		expect(text).toContain('ssh_pwauth: false');
		expect(text).toContain('  - qemu-guest-agent');
		expect(text).toContain('systemctl enable --now qemu-guest-agent');
		expect(text).not.toMatch(/^\s+passwd:/m);
	});

	it('enables password login only with a hash, and never writes a plain password', () => {
		const hash = sha512Crypt('s3cret', 'abcdefgh');
		const text = userData({ ...opts, sshKeys: [], passwordHash: hash });
		expect(text).toContain('lock_passwd: false');
		expect(text).toContain(`passwd: "${hash}"`);
		expect(text).toContain('ssh_pwauth: true');
		expect(text).not.toContain('s3cret');
		expect(text).not.toContain('ssh_authorized_keys');
	});

	it('leaves the agent out when asked, and uses custom user-data as given', () => {
		expect(userData({ ...opts, installAgent: false })).not.toContain('packages');
		expect(userData({ ...opts, customUserData: '#cloud-config\nruncmd: [ls]' })).toBe('#cloud-config\nruncmd: [ls]\n');
	});

	it('quotes values so they cannot inject YAML', () => {
		const text = userData({ ...opts, user: 'alex', sshKeys: ['ssh-ed25519 AAAA "x" # c'] });
		expect(text).toContain('"ssh-ed25519 AAAA \\"x\\" # c"');
	});

	it('names the instance and host in meta-data', () => {
		expect(metaData(opts)).toBe('instance-id: "vmm-abc"\nlocal-hostname: "web-01"\n');
	});
});
