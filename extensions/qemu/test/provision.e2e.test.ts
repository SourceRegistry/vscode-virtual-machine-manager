/**
 * Creates a machine from a cloud image with the built-in cloud-init seed disk and signs in to it. Opt-in, slow:
 *
 *   VMM_E2E_GUEST_IMAGE=/path/debian-12-genericcloud-arm64.qcow2 npx vitest run extensions/qemu/test/provision.e2e.test.ts
 *
 * No ISO tool is used (the seed disk is built by the extension), so this is the proof that cloud-init accepts it:
 * the user, the key, the host name and the guest agent must all come from it.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFreePort } from '../../../src/extension/ssh/probe';
import { QemuProvider } from '../src/QemuProvider';

const image = process.env.VMM_E2E_GUEST_IMAGE;

describe.skipIf(!image)('a machine from a cloud image', () => {
	let dir: string;
	let keyFile: string;
	let connection: Awaited<ReturnType<QemuProvider['connect']>>;
	let vmId: string;
	const progress: Array<{ message?: string; fraction?: number }> = [];

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-prov-'));
		keyFile = path.join(dir, 'id_ed25519');
		execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyFile]);
		const log = { info() {}, warn() {}, error() {}, debug() {} };
		connection = await new QemuProvider({ defaultQemuPath: () => undefined }).connect({ id: 'c', name: 'c', providerId: 'qemu', config: { shutdownTimeout: 60 } }, {}, { storagePath: dir, log });
	}, 60_000);

	afterAll(async () => {
		await connection?.power('local', vmId, 'stop').catch(() => undefined);
		connection?.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const values = (extra: Record<string, string | number | boolean | undefined> = {}) => ({
		name: 'Cloud Test',
		source: 'cloud',
		cloudImage: 'custom',
		cloudImageFile: image,
		cpus: 2,
		memoryMB: 2048,
		diskGB: 6,
		ciUser: 'tester',
		ciSshKey: fs.readFileSync(`${keyFile}.pub`, 'utf8').trim(),
		serial: false,
		...extra
	});

	it('refuses what cannot work before doing any work', async () => {
		await expect(connection.createVm('local', values({ ciSshKey: '', ciPassword: '' }))).rejects.toThrow(/no way to sign in/);
		await expect(connection.createVm('local', values({ ciUser: 'root' }))).rejects.toThrow(/not a valid user name/);
		await expect(connection.createVm('local', values({ cloudImageFile: path.join(dir, 'missing.qcow2') }))).rejects.toThrow(/Image not found/);
		await expect(connection.createVm('local', values({ cloudImage: 'nope' }))).rejects.toThrow(/Choose a cloud image/);
		expect(await connection.listVms('local')).toEqual([]);
	});

	it('creates the machine with a disk, a seed disk and no installer', async () => {
		const vm = await connection.createVm('local', values(), (u) => progress.push(u));
		vmId = vm.id;
		expect(progress.length).toBeGreaterThan(2);
		expect(progress.at(-1)).toMatchObject({ fraction: 1 });
		const fractions = progress.map((p) => p.fraction).filter((f): f is number => f !== undefined);
		expect(fractions).toEqual([...fractions].sort((a, b) => a - b));

		const details = await connection.getVmDetails!('local', vmId);
		const disk = details.disks.find((d) => d.kind === 'disk')!;
		expect(disk).toMatchObject({ format: 'qcow2' });
		expect(disk.sizeBytes).toBe(6 * 1024 ** 3);
		expect(details.disks.find((d) => d.kind === 'cdrom')?.path).toMatch(/seed\.iso$/);
		expect((await connection.getVmConfig('local', vmId)).values).toMatchObject({ name: 'Cloud Test' });
	}, 120_000);

	it('a clone of a template gets its own seed disk with a new instance id', async () => {
		const seedOf = async (id: string) => (await connection.getVmDetails!('local', id)).disks.find((d) => d.kind === 'cdrom')!.path!;
		await connection.setTemplate!('local', vmId, true);
		const copy = await connection.cloneVm!('local', vmId, 'Cloud Copy');
		try {
			const [original, own] = [await seedOf(vmId), await seedOf(copy.id)];
			expect(own).not.toBe(original);
			expect(fs.readFileSync(own).includes(`vmm-${copy.id}`)).toBe(true);
			expect(fs.readFileSync(own).includes(`vmm-${vmId}`)).toBe(false);
			expect(fs.readFileSync(original).includes(`vmm-${vmId}`)).toBe(true);
		} finally {
			await connection.setTemplate!('local', vmId, false);
			await connection.deleteVm('local', copy.id, { deleteDisks: true }).catch(() => undefined);
		}
	}, 120_000);

	it('boots, runs cloud-init, and lets the new user in with the key', async () => {
		await connection.power('local', vmId, 'start');
		let addresses: string[] = [];
		const deadline = Date.now() + 8 * 60_000;
		while (Date.now() < deadline && !addresses.length) {
			await new Promise((r) => setTimeout(r, 5000));
			addresses = (await connection.getVmDetails!('local', vmId)).nics[0]?.ipAddresses ?? [];
		}
		expect(addresses.length, 'cloud-init never installed the guest agent').toBeGreaterThan(0);

		const hostPort = await findFreePort(2222);
		await connection.addPortForward!('local', vmId, { protocol: 'tcp', hostPort, guestPort: 22 });
		const ssh = (command: string) =>
			execFileSync('ssh', ['-i', keyFile, '-p', String(hostPort), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`, 'tester@127.0.0.1', command], { encoding: 'utf8', timeout: 60_000 });
		let out = '';
		for (let i = 0; i < 20 && !out; i++) {
			try {
				out = ssh('whoami; hostname; sudo -n true && echo sudo-ok');
			} catch {
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
		expect(out).toContain('tester');
		expect(out).toContain('cloud-test');
		expect(out).toContain('sudo-ok');
		// The disk was enlarged and the root file system grown into it.
		expect(Number(ssh("df -BG --output=size / | tail -1 | tr -dc 0-9"))).toBeGreaterThanOrEqual(5);
	}, 12 * 60_000);

	it('shuts down cleanly', async () => {
		await connection.power('local', vmId, 'shutdown');
		expect((await connection.listVms('local')).find((v) => v.id === vmId)?.state).toBe('stopped');
	}, 120_000);
});
