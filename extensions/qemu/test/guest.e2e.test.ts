/**
 * Boots a real Linux guest and checks what only a cooperating guest can prove: the guest agent
 * (NIC addresses, clean shutdown) and SSH (a forward chosen from the VM's details, a real sshd, and a login
 * with plain ssh through the config block VM Manager writes). Opt-in, slow (minutes), and needs a cloud image of the host's
 * architecture:
 *
 *   VMM_E2E_GUEST_IMAGE=/path/debian-12-genericcloud-arm64.qcow2 npx vitest run extensions/qemu/test/guest.e2e.test.ts
 *
 * The image is copied, never modified. The guest is configured through a cloud-init `cidata` seed ISO,
 * attached as the VM's CD drive, and installs qemu-guest-agent on first boot, so the guest needs
 * internet access through the host. Building the ISO needs `hdiutil` (macOS) or `genisoimage`,
 * `mkisofs` or `xorriso`; without one the test is skipped. Debian's `genericcloud` image works; any
 * cloud-init image with apt does.
 *
 * (The network seed `-smbios type=1,serial=ds=nocloud;s=http://…` was tried first: cloud-init 22.4
 * on Debian 12 fetched the files and still ended with no datasource, so it is not used.)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFreePort, probeSsh } from '../../../src/extension/ssh/probe';
import { chooseSshTarget, hostAlias, renderSshConfigBlock, upsertSshConfigBlock } from '../../../src/shared/ssh';
import { QemuProvider } from '../src/QemuProvider';

const image = process.env.VMM_E2E_GUEST_IMAGE;

// Each runcmd item is one command; Debian starts the agent from a udev rule, which has already
// fired by the time the package is installed, so it is started explicitly.
const userData = (publicKey: string) => `#cloud-config
ssh_authorized_keys:
  - ${publicKey}
package_update: true
packages: [qemu-guest-agent]
runcmd:
  - [systemctl, start, qemu-guest-agent]
`;
const META_DATA = 'instance-id: vmm-e2e\nlocal-hostname: vmm-e2e\n';

/** Builds a cloud-init `cidata` ISO, or returns `undefined` when no ISO tool is installed. */
function buildSeedIso(workDir: string, publicKey: string): string | undefined {
	const src = path.join(workDir, 'seed');
	fs.mkdirSync(src);
	fs.writeFileSync(path.join(src, 'user-data'), userData(publicKey));
	fs.writeFileSync(path.join(src, 'meta-data'), META_DATA);
	const out = path.join(workDir, 'seed.iso');
	const attempts: Array<[string, string[]]> = [
		['hdiutil', ['makehybrid', '-quiet', '-iso', '-joliet', '-default-volume-name', 'cidata', '-o', out, src]],
		['genisoimage', ['-quiet', '-output', out, '-volid', 'cidata', '-joliet', '-rock', src]],
		['mkisofs', ['-quiet', '-output', out, '-volid', 'cidata', '-joliet', '-rock', src]],
		['xorriso', ['-as', 'mkisofs', '-quiet', '-output', out, '-volid', 'cidata', '-joliet', '-rock', src]]
	];
	for (const [tool, args] of attempts) {
		try {
			execFileSync(tool, args, { stdio: 'ignore' });
			if (fs.existsSync(out)) return out;
		} catch {
			// try the next tool
		}
	}
	return undefined;
}

describe.skipIf(!image)('QEMU guest agent against a real Linux guest', () => {
	let dir: string;
	let connection: Awaited<ReturnType<QemuProvider['connect']>>;
	let vmId: string;
	let seedIso: string | undefined;
	let keyFile: string;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-guest-'));
		// A throwaway key pair; the public half goes to the default user (`debian`) through cloud-init.
		keyFile = path.join(dir, 'id_ed25519');
		execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyFile]);
		seedIso = buildSeedIso(dir, fs.readFileSync(`${keyFile}.pub`, 'utf8').trim());

		const log = { info() {}, warn() {}, error() {}, debug() {} };
		const provider = new QemuProvider({ defaultQemuPath: () => undefined });
		connection = await provider.connect({ id: 'c', name: 'c', providerId: 'qemu', config: { shutdownTimeout: 60 } }, {}, { storagePath: dir, log });
		const vm = await connection.createVm('local', { name: 'guest-e2e', cpus: 2, memoryMB: 2048, diskGB: 4, serial: false });
		vmId = vm.id;

		// Replace the empty disk with a copy of the cloud image, enlarged so the first boot has room.
		const disk = (await connection.getVmDetails!('local', vmId)).disks.find((d) => d.kind === 'disk')!.path!;
		execFileSync('qemu-img', ['convert', '-O', 'qcow2', image!, disk]);
		execFileSync('qemu-img', ['resize', disk, '4G']);

		const config = await connection.getVmConfig('local', vmId);
		await connection.updateVm('local', vmId, { ...config.values, cdrom: seedIso });
	}, 120_000);

	afterAll(async () => {
		await connection?.power('local', vmId, 'stop').catch(() => undefined);
		connection?.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('answers on the guest agent and reports the NIC address', async () => {
		if (!seedIso) return console.warn('No ISO tool (hdiutil, genisoimage, mkisofs, xorriso): guest test skipped');
		await connection.power('local', vmId, 'start');

		// First boot: cloud-init fetches the seed, installs the agent, starts it.
		let addresses: string[] = [];
		const deadline = Date.now() + 8 * 60_000;
		while (Date.now() < deadline && !addresses.length) {
			await new Promise((r) => setTimeout(r, 5000));
			const nic = (await connection.getVmDetails!('local', vmId)).nics[0];
			addresses = nic?.ipAddresses ?? [];
		}
		expect(addresses.length, 'guest agent never reported an address').toBeGreaterThan(0);
		expect(addresses.some((a) => a.startsWith('10.0.2.'))).toBe(true);
	}, 12 * 60_000);

	it('is reachable over SSH through a port forward chosen from its real details, by plain ssh and the written config', async () => {
		if (!seedIso) return;
		// QEMU user networking is NAT: the guest address is not a route, so without a forward there is no target.
		const before = await connection.getVmDetails!('local', vmId);
		expect(before.nics[0]?.reachable).toBe(false);
		expect(chooseSshTarget(before)).toBeUndefined();

		const hostPort = await findFreePort(2222);
		await connection.addPortForward!('local', vmId, { protocol: 'tcp', hostPort, guestPort: 22 });
		const target = chooseSshTarget(await connection.getVmDetails!('local', vmId));
		expect(target).toEqual({ host: '127.0.0.1', port: hostPort, via: 'forward' });

		// sshd must answer with its identification line: the check Connect with Remote-SSH makes first.
		let probe = await probeSsh(target!.host, target!.port, 3000);
		for (let i = 0; i < 20 && !probe.ok; i++) probe = await probeSsh(target!.host, target!.port, 3000);
		expect(probe).toMatchObject({ ok: true });
		expect((probe as { banner: string }).banner).toMatch(/^SSH-2\.0-OpenSSH/);

		// The block VM Manager writes, used by the stock ssh client exactly as a user (or Remote-SSH) would.
		const key = 'c/local/guest-e2e';
		const alias = hostAlias('guest-e2e', key);
		const config = path.join(dir, 'ssh_config');
		fs.writeFileSync(config, upsertSshConfigBlock('', key, renderSshConfigBlock(key, { alias, host: target!.host, port: target!.port, user: 'debian', vmName: 'guest-e2e' })));
		const out = execFileSync(
			'ssh',
			['-F', config, '-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`, alias, 'echo vmm-ssh-ok; whoami'],
			{ encoding: 'utf8', timeout: 60_000 }
		);
		expect(out).toContain('vmm-ssh-ok');
		expect(out).toContain('debian');
		// The host key was recorded under the alias, not under 127.0.0.1:port.
		expect(fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8')).toMatch(new RegExp(`^${alias} `, 'm'));
	}, 5 * 60_000);

	it('shuts down cleanly through the agent', async () => {
		if (!seedIso) return;
		// A clean shutdown through the agent must end in `stopped` without the force-stop path.
		const started = Date.now();
		await connection.power('local', vmId, 'shutdown');
		expect((await connection.listVms('local')).find((v) => v.id === vmId)?.state).toBe('stopped');
		expect(Date.now() - started).toBeLessThan(60_000);
	}, 5 * 60_000);
});
