/**
 * The QEMU provider on an "SSH host" against a real QEMU. Opt-in: `VMM_E2E_QEMU=1 npx vitest run extensions/qemu/test/remote.e2e.test.ts`.
 * Every command and tunnel goes through `fakeSsh.mjs`, which stands in for the ssh client and runs them on this
 * machine, so this proves the remote code path (shell commands, file access, `-W` tunnels), not sshd itself.
 */
import { execFileSync, spawn } from 'node:child_process';
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
		expect(connection.capabilities).toMatchObject({ create: true, snapshots: true, clone: true, consoles: ['vnc', 'serial'], adopt: true, passthrough: false, importFolder: false });
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

	it('creates a machine from a cloud image file on the host, with the seed disk written there', async () => {
		const base = path.join(dir, 'base-image.qcow2');
		execFileSync('qemu-img', ['create', '-f', 'qcow2', base, '64M']);
		const progress: string[] = [];
		const vm = await connection.createVm('local', { name: 'remote-cloud', source: 'cloud', cloudImage: 'custom', cloudImageFile: base, cpus: 1, memoryMB: 256, diskGB: 1, ciUser: 'tester', ciPassword: 'pw', ciSshKey: '', serial: false }, (u) => u.message && progress.push(u.message));
		const vmDir = path.join(dir, 'remote vms', vm.id);
		expect(fs.existsSync(path.join(vmDir, 'disk0.qcow2'))).toBe(true);
		const seed = path.join(vmDir, 'seed.iso');
		// The bytes crossed a text channel as base64: they must still be an ISO that names the volume cidata.
		const iso = fs.readFileSync(seed);
		expect(iso.subarray(16 * 2048 + 1, 16 * 2048 + 6).toString()).toBe('CD001');
		expect(iso.subarray(16 * 2048 + 40, 16 * 2048 + 46).toString()).toBe('cidata');
		expect(iso.toString('latin1')).toContain('instance-id');
		expect(progress.at(-1)).toBe('Done');
		const details = await connection.getVmDetails!('local', vm.id);
		expect(details.disks.find((d) => d.kind === 'cdrom')?.path).toBe(seed);
		await connection.deleteVm('local', vm.id, { deleteDisks: true });
	}, 60_000);

	describe.skipIf(process.platform === 'win32')('QEMU started outside the extension, on the host', () => {
		const children: Array<ReturnType<typeof spawn>> = [];
		afterAll(() => children.forEach((c) => c.kill('SIGKILL')));

		const outside = async (name: string, qmp: string, extra: string[] = []) => {
			const disk = path.join(dir, `${name}.qcow2`);
			execFileSync('qemu-img', ['create', '-f', 'qcow2', disk, '64M']);
			const child = spawn('qemu-system-x86_64', ['-name', name, '-machine', 'q35', '-accel', 'tcg', '-m', '128', '-smp', '1', '-drive', `file=${disk},if=none,id=d0,format=qcow2`, '-device', 'ide-hd,drive=d0,bus=ide.0', '-qmp', qmp, ...extra], { stdio: 'ignore' });
			children.push(child);
			return child;
		};

		it('attaches over a unix socket, observes it and powers it off', async () => {
			const socket = path.join(dir, 'outside.sock');
			const child = await outside('remote-outside', `unix:${socket},server=on,wait=off`, ['-display', 'none']);
			for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));

			const found = (await connection.scanExternalVms!('local')).find((v) => v.name === 'remote-outside');
			expect(found).toMatchObject({ id: String(child.pid), controllable: true });
			const { vm, warning } = await connection.adoptExternalVm!('local', found!.id);
			expect(warning).toBeUndefined();
			expect(vm).toMatchObject({ name: 'remote-outside', origin: 'adopted', state: 'running', controllable: true });
			expect((await connection.scanExternalVms!('local')).some((v) => v.name === 'remote-outside')).toBe(false);

			// The definition is on the host, next to the ones this extension made.
			expect(fs.existsSync(path.join(dir, 'remote vms', vm.id, 'runtime.json'))).toBe(true);
			expect((await connection.getVmDetails!('local', vm.id)).disks.find((d) => d.kind === 'disk')?.format).toBe('qcow2');
			expect((await connection.getVmStats!('local', vm.id)).memoryUsedMB).toBeGreaterThan(0);

			await connection.power('local', vm.id, 'stop');
			for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await new Promise((r) => setTimeout(r, 100));
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
			expect((await connection.listVms('local')).some((v) => v.id === vm.id)).toBe(false);
		}, 90_000);

		it('attaches over TCP and opens the display it has', async () => {
			const qmpPort = await (await import('../src/QemuProvider')).freePort();
			const child = await outside('remote-tcp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`, ['-display', 'none', '-vnc', '127.0.0.1:41']);
			await new Promise((r) => setTimeout(r, 1500));
			const found = (await connection.scanExternalVms!('local')).find((v) => v.name === 'remote-tcp');
			expect(found).toMatchObject({ controllable: true });
			const { vm } = await connection.adoptExternalVm!('local', found!.id);
			expect((await connection.listVms('local')).find((v) => v.id === vm.id)).toMatchObject({ state: 'running', consoles: ['vnc'] });
			const vnc = await connection.openConsole!('local', vm.id, 'vnc');
			const banner = await new Promise<string>((resolve, reject) => {
				vnc.stream.once('data', (d: Buffer) => resolve(d.toString('latin1')));
				vnc.stream.once('error', reject);
				setTimeout(() => reject(new Error('no VNC banner')), 5000);
			});
			expect(banner).toMatch(/^RFB /);
			vnc.dispose();
			// Detach without touching the process.
			await connection.deleteVm('local', vm.id, { deleteDisks: false });
			expect(child.exitCode).toBeNull();
			expect(fs.existsSync(path.join(dir, 'remote vms', vm.id))).toBe(false);
		}, 90_000);
	});
});
