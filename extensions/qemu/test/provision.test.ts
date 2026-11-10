import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isFieldVisible, type FieldValues } from '@vmm/sdk';
import { describe, expect, it } from 'vitest';
import { cloudFields, defaultCloudUser, localSshPublicKey, parseKeys } from '../src/provision';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop';

describe('local defaults', () => {
	it('offers the first public key in ~/.ssh, ed25519 before rsa', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-home-'));
		fs.mkdirSync(path.join(home, '.ssh'));
		try {
			expect(localSshPublicKey(home)).toBe('');
			fs.writeFileSync(path.join(home, '.ssh', 'id_rsa.pub'), 'ssh-rsa AAAAB3NzaC1yc2E rsa-key\n');
			expect(localSshPublicKey(home)).toBe('ssh-rsa AAAAB3NzaC1yc2E rsa-key');
			fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), `${KEY}\n`);
			expect(localSshPublicKey(home)).toBe(KEY);
			fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'garbage\n');
			expect(localSshPublicKey(home)).toBe('ssh-rsa AAAAB3NzaC1yc2E rsa-key');
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
	it('turns a computer user name into a guest account name', () => {
		expect(defaultCloudUser('Alex.Slaa')).toBe('alexslaa');
		expect(defaultCloudUser('root')).toBe('user');
		expect(defaultCloudUser('123')).toBe('user');
		expect(defaultCloudUser('')).toBe('user');
	});
	it('reads one key per line', () => {
		expect(parseKeys(` ${KEY}\n\n${KEY}\r\n`)).toEqual([KEY, KEY]);
		expect(parseKeys(undefined)).toEqual([]);
	});
});

describe('cloud fields', () => {
	const fields = cloudFields({ installed: ['aarch64'], remote: false, cached: new Set(['debian-12-genericcloud-arm64.qcow2']) });
	const visible = (values: FieldValues) => fields.filter((f) => isFieldVisible(f, values, fields)).map((f) => f.key);

	it('lists the images of the installed architectures, marks the downloaded ones, and ends with a file', () => {
		const options = fields.find((f) => f.key === 'cloudImage')!.options!;
		expect(options.map((o) => o.value)).toEqual(['debian-13@aarch64', 'debian-12@aarch64', 'ubuntu-24.04@aarch64', 'ubuntu-22.04@aarch64', 'custom']);
		expect(options.find((o) => o.value === 'debian-12@aarch64')!.description).toBe('Downloaded');
		expect(options.find((o) => o.value === 'ubuntu-24.04@aarch64')!.description).toMatch(/Downloaded when you create/);
		expect(fields.find((f) => f.key === 'cloudImage')!.default).toBe('debian-13@aarch64');
	});

	it('shows nothing unless the source is a cloud image', () => {
		expect(visible({})).toEqual([]);
		expect(visible({ source: 'iso' })).toEqual([]);
	});

	it('asks for the user, key and password, and for a file only with a custom image', () => {
		expect(visible({ source: 'cloud', cloudImage: 'debian-12@aarch64' })).toEqual(['cloudImage', 'ciUser', 'ciSshKey', 'ciPassword', 'ciAgent', 'ciHostname', 'ciUserData']);
		expect(visible({ source: 'cloud', cloudImage: 'custom' })).toContain('cloudImageFile');
	});

	it('takes the image path as text on a remote host', () => {
		const remote = cloudFields({ installed: ['x86_64'], remote: true, cached: new Set() });
		expect(remote.find((f) => f.key === 'cloudImageFile')!.remotePath).toBe(true);
		expect(fields.find((f) => f.key === 'cloudImageFile')!.remotePath).toBe(false);
	});
});
