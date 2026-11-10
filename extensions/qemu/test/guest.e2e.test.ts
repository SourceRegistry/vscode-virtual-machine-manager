/**
 * Boots a real Linux guest and checks what only a cooperating guest can prove: the guest agent
 * (NIC addresses, clean shutdown). Opt-in, slow (minutes), and needs a cloud image of the host's
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
import { QemuProvider } from '../src/QemuProvider';

const image = process.env.VMM_E2E_GUEST_IMAGE;

// Each runcmd item is one command; Debian starts the agent from a udev rule, which has already
// fired by the time the package is installed, so it is started explicitly.
const USER_DATA = `#cloud-config
package_update: true
packages: [qemu-guest-agent]
runcmd:
  - [systemctl, start, qemu-guest-agent]
`;
const META_DATA = 'instance-id: vmm-e2e\nlocal-hostname: vmm-e2e\n';

/** Builds a cloud-init `cidata` ISO, or returns `undefined` when no ISO tool is installed. */
function buildSeedIso(workDir: string): string | undefined {
	const src = path.join(workDir, 'seed');
	fs.mkdirSync(src);
	fs.writeFileSync(path.join(src, 'user-data'), USER_DATA);
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

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-guest-'));
		seedIso = buildSeedIso(dir);

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

	it('answers on the guest agent and reports the NIC address, then shuts down cleanly', async () => {
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

		// A clean shutdown through the agent must end in `stopped` without the force-stop path.
		const started = Date.now();
		await connection.power('local', vmId, 'shutdown');
		expect((await connection.listVms('local')).find((v) => v.id === vmId)?.state).toBe('stopped');
		expect(Date.now() - started).toBeLessThan(60_000);
	}, 12 * 60_000);
});
