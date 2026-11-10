/**
 * The QEMU provider on an "SSH host" against a real QEMU. Opt-in: `VMM_E2E_QEMU=1 npx vitest run extensions/qemu/test/remote.e2e.test.ts`.
 * Every command and tunnel goes through `fakeSsh.mjs`, which stands in for the ssh client and runs them on this
 * machine, so this proves the remote code path (shell commands, file access, `-W` tunnels), not sshd itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QemuProvider } from '../src/QemuProvider';

describe.skipIf(!process.env.VMM_E2E_QEMU)('QEMU provider on an SSH host', () => {
	let dir: string;
	let connection: Awaited<ReturnType<QemuProvider['connect']>>;
	let vmId: string;
	let iso: string;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-remote-'));
		const log = { info() {}, warn() {}, error() {}, debug() {} };
		const provider = new QemuProvider({ defaultQemuPath: () => undefined, sshCommand: path.resolve(__dirname, 'fakeSsh.mjs') });
		connection = await provider.connect(
			{ id: 'c', name: 'c', providerId: 'qemu', config: { connection: 'ssh', sshHost: 'lab', vmDirectory: path.join(dir, 'remote vms'), accelerator: 'tcg', shutdownTimeout: 5 } },
			{},
			{ storagePath: path.join(dir, 'unused'), log }
		);
		iso = path.join(dir, 'install.iso');
		fs.writeFileSync(iso, Buffer.alloc(2 * 1024 * 1024));
		const vm = await connection.createVm('local', { name: 'remote-e2e', arch: 'x86_64', cpus: 1, memoryMB: 256, diskGB: 1, cdrom: iso, firmware: 'uefi', diskBus: 'sata', nic: 'e1000', serial: true });
		vmId = vm.id;
	}, 60_000);

	afterAll(async () => {
		await connection?.power('local', vmId, 'stop').catch(() => undefined);
		connection?.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('keeps its definition on the host, and offers only what works there', async () => {
		expect(fs.existsSync(path.join(dir, 'remote vms', vmId, 'vm.json'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'remote vms', vmId, 'disk0.qcow2'))).toBe(true);
		expect(connection.capabilities).toMatchObject({ create: true, snapshots: true, clone: true, consoles: ['vnc', 'serial'], adopt: false, passthrough: false, importFolder: false });
		const nodes = await connection.listNodes();
		expect(nodes[0]).toMatchObject({ status: 'online' });
		expect(nodes[0]!.facts?.some((f) => f.label === 'Platform' && f.value.includes('lab'))).toBe(true);
		const vms = await connection.listVms('local');
		expect(vms).toHaveLength(1);
		expect(vms[0]).toMatchObject({ name: 'remote-e2e', state: 'stopped' });
	});

	it('starts, inventories, samples, and opens the display and serial console through tunnels', async () => {
		await connection.power('local', vmId, 'start');
		expect(['running', 'starting']).toContain((await connection.listVms('local'))[0]!.state);
		await new Promise((r) => setTimeout(r, 1500));

		const details = await connection.getVmDetails!('local', vmId);
		expect(details.disks.find((d) => d.kind === 'disk')).toMatchObject({ id: 'disk0', format: 'qcow2', sizeBytes: 1024 ** 3 });
		expect(details.disks.find((d) => d.kind === 'cdrom')).toMatchObject({ id: 'cd0', path: iso });
		expect(details.devices.some((d) => d.label === 'VGA controller')).toBe(true);

		const stats = await connection.getVmStats!('local', vmId);
		expect(stats.disks?.some((d) => d.id === 'disk0')).toBe(true);

		await connection.ejectMedia!('local', vmId, 'cd0');
		expect((await connection.getVmDetails!('local', vmId)).disks.find((d) => d.id === 'cd0')?.path).toBeUndefined();
		await connection.insertMedia!('local', vmId, 'cd0', iso);
		expect((await connection.getVmDetails!('local', vmId)).disks.find((d) => d.id === 'cd0')?.path).toBe(iso);

		// The display speaks first (RFB), so a banner proves the tunnel carries the VNC stream.
		const vnc = await connection.openConsole!('local', vmId, 'vnc');
		const banner = await new Promise<string>((resolve, reject) => {
			vnc.stream.once('data', (d: Buffer) => resolve(d.toString('latin1')));
			vnc.stream.once('error', reject);
			setTimeout(() => reject(new Error('no VNC banner')), 5000);
		});
		expect(banner).toMatch(/^RFB \d{3}\.\d{3}/);
		vnc.dispose();

		const serial = await connection.openConsole!('local', vmId, 'serial');
		expect(serial.stream.destroyed).toBe(false);
		serial.dispose();
	}, 90_000);

	it('adds and removes a port forward on the running VM', async () => {
		await connection.addPortForward!('local', vmId, { protocol: 'tcp', hostPort: 45222, guestPort: 22 });
		expect((await connection.getVmDetails!('local', vmId)).forwards?.some((f) => f.hostPort === 45222 && f.guestPort === 22)).toBe(true);
		await connection.removePortForward!('local', vmId, { protocol: 'tcp', hostPort: 45222, guestPort: 22 });
		expect((await connection.getVmDetails!('local', vmId)).forwards?.some((f) => f.hostPort === 45222)).toBe(false);
	}, 30_000);

	it('powers off, snapshots, reverts and clones on the host', async () => {
		await connection.power('local', vmId, 'stop');
		expect((await connection.listVms('local'))[0]!.state).toBe('stopped');
		const snap = await connection.createSnapshot!('local', vmId, 'before');
		expect((await connection.listSnapshots!('local', vmId)).map((s) => s.name)).toContain('before');
		await connection.revertSnapshot!('local', vmId, snap.id);
		const clone = await connection.cloneVm!('local', vmId, 'remote-clone');
		expect(fs.existsSync(path.join(dir, 'remote vms', clone.id, 'disk0.qcow2'))).toBe(true);
		expect((await connection.listVms('local')).map((v) => v.name).sort()).toEqual(['remote-clone', 'remote-e2e']);
		await connection.deleteVm('local', clone.id, { deleteDisks: true });
		expect(fs.existsSync(path.join(dir, 'remote vms', clone.id))).toBe(false);
	}, 90_000);
});
