/**
 * End to end against a real libvirt (`VMM_E2E_LIBVIRT=1`): defines a throw-away domain in `qemu:///session`,
 * then drives the provider through virsh. Written for Apple Silicon (HVF, aarch64 `virt`); other hosts skip it.
 * `VMM_E2E_GUEST_IMAGE` (a qcow2) adds a disk, so the snapshot steps have something to snapshot. When it is
 * a cloud image (debian-*-genericcloud-arm64.qcow2), a domain is also created from it with cloud-init and
 * booted until the guest agent cloud-init installs answers (needs internet in the guest, a few minutes).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClusterConfig, ProviderContext } from '@vmm/sdk';
import { LibvirtProvider, type LibvirtConnection } from '../src/LibvirtProvider';
import { findVirsh } from '../src/virsh';

const virsh = findVirsh();
const enabled = process.env.VMM_E2E_LIBVIRT === '1' && !!virsh && process.platform === 'darwin' && process.arch === 'arm64';
const image = process.env.VMM_E2E_GUEST_IMAGE;
const NAME = `vmm-e2e-${process.pid}`;
const SNAP = `${NAME}-snap`;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const context = { log, storagePath: tmpdir() } as unknown as ProviderContext;
const cluster: ClusterConfig = { id: 'e2e', name: 'e2e', providerId: 'libvirt', config: { connection: 'session', shutdownTimeout: 5 } };

const v = (...args: string[]) => execFileSync(virsh!, ['-c', 'qemu:///session', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/opt/homebrew/sbin` } });
const until = async (check: () => Promise<boolean>, what: string, ms = 30_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 500)); }
	throw new Error(`Timed out waiting for ${what}`);
};

describe.skipIf(!enabled)('libvirt provider against real libvirt', () => {
	let dir: string;
	let connection: LibvirtConnection;
	let id: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'vmm-libvirt-'));
		const iso = join(dir, 'empty.iso');
		writeFileSync(iso, Buffer.alloc(1024 * 1024));
		writeFileSync(join(dir, 'd.xml'), `<domain type='hvf'><name>${NAME}</name><memory unit='MiB'>512</memory><vcpu>1</vcpu>
<os firmware='efi'><type arch='aarch64' machine='virt'>hvm</type></os><features><gic version='3'/></features><cpu mode='host-passthrough'/>
<devices><disk type='file' device='cdrom'><driver name='qemu' type='raw'/><target dev='sda' bus='scsi'/><readonly/></disk><controller type='scsi' model='virtio-scsi'/>
<interface type='user'><model type='virtio'/></interface><serial type='pty'/><console type='pty'/><graphics type='vnc' autoport='yes' listen='127.0.0.1'/><video><model type='virtio'/></video></devices></domain>`);
		v('define', join(dir, 'd.xml'));
		if (image && existsSync(image)) {
			// libvirt cannot snapshot a UEFI domain here (raw nvram), so the snapshot domain boots no firmware.
			execFileSync('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', image, '-F', 'qcow2', join(dir, 'disk.qcow2'), '4G'], { env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } });
			writeFileSync(join(dir, 's.xml'), `<domain type='hvf'><name>${SNAP}</name><memory unit='MiB'>512</memory><vcpu>1</vcpu><os><type arch='aarch64' machine='virt'>hvm</type></os><features><gic version='3'/></features><cpu mode='host-passthrough'/>
<devices><disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='${join(dir, 'disk.qcow2')}'/><target dev='vda' bus='virtio'/></disk></devices></domain>`);
			v('define', join(dir, 's.xml'));
		}
		connection = await new LibvirtProvider().connect(cluster, {}, context);
	}, 60_000);

	afterAll(() => {
		connection?.dispose();
		for (const name of [NAME, SNAP]) {
			try { v('destroy', name); } catch { /* not running */ }
			try { v('undefine', name, '--nvram', '--managed-save', '--snapshots-metadata'); } catch { /* gone */ }
		}
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it('describes the host', async () => {
		const [node] = await connection.listNodes();
		expect(node).toMatchObject({ status: 'online' });
		expect(node!.cpus).toBeGreaterThan(0);
		expect(node!.facts!.map((f) => f.label)).toEqual(expect.arrayContaining(['libvirt', 'Hypervisor']));
	});

	it('lists the stopped domain with its consoles', async () => {
		const vm = (await connection.listVms('host')).find((x) => x.name === NAME)!;
		expect(vm).toMatchObject({ state: 'stopped', cpus: 1, memoryMB: 512, consoles: ['vnc', 'serial'] });
		id = vm.id;
	});

	it('starts it, and reports details and stats', async () => {
		await connection.power('host', id, 'start');
		await until(async () => (await connection.listVms('host')).find((x) => x.id === id)?.state === 'running', 'running');
		const details = await connection.getVmDetails('host', id);
		expect(details.disks.find((d) => d.kind === 'cdrom')).toMatchObject({ id: 'sda', removable: true });
		expect(details.nics[0]).toMatchObject({ model: 'virtio', reachable: false });
		const first = await connection.getVmStats('host', id);
		await new Promise((r) => setTimeout(r, 1500));
		const stats = await connection.getVmStats('host', id);
		expect(stats.memoryMB).toBe(512);
		expect(stats.cpuUsage).toBeGreaterThanOrEqual(0);
		expect(stats.memoryUsedMB).toBeGreaterThan(0);
		expect(first.timestamp).toBeLessThan(stats.timestamp);
		expect((await connection.listVms('host')).find((x) => x.id === id)!.uptimeSeconds).toBeGreaterThanOrEqual(0);
	}, 60_000);

	it('opens the VNC display (the RFB banner) and the serial console', async () => {
		const display = await connection.openConsole('host', id, 'vnc');
		const banner = await new Promise<string>((resolve, reject) => {
			display.stream.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1', 0, 12)));
			display.stream.once('error', reject);
			setTimeout(() => reject(new Error('no VNC banner')), 5000);
		});
		expect(banner).toMatch(/^RFB 00\d\.00\d/);
		display.dispose();
		const serial = await connection.openConsole('host', id, 'serial');
		serial.dispose();
	}, 30_000);

	it('inserts and ejects media on the running domain', async () => {
		const iso = join(dir, 'empty.iso');
		await connection.insertMedia('host', id, 'sda', iso);
		expect((await connection.getVmDetails('host', id)).disks.find((d) => d.id === 'sda')!.path).toBe(iso);
		expect((await connection.listVms('host')).find((x) => x.id === id)!.mediaInserted).toBe(true);
		await connection.ejectMedia('host', id, 'sda');
		expect((await connection.getVmDetails('host', id)).disks.find((d) => d.id === 'sda')!.path).toBeUndefined();
	}, 30_000);

	it.runIf(!!image)('takes, lists, reverts and deletes a snapshot (stopped, then running with memory)', async () => {
		const snapId = (await connection.listVms('host')).find((x) => x.name === SNAP)!.id;
		expect(await connection.createSnapshot('host', snapId, 'before')).toMatchObject({ id: 'before', includesMemory: false });
		await connection.power('host', snapId, 'start');
		await until(async () => (await connection.listVms('host')).find((x) => x.id === snapId)?.state === 'running', 'running');
		expect(await connection.createSnapshot('host', snapId, 'live')).toMatchObject({ id: 'live', includesMemory: true });
		expect((await connection.listSnapshots('host', snapId)).map((s) => s.id)).toEqual(['before', 'live']);
		await connection.revertSnapshot('host', snapId, 'before');
		await connection.power('host', snapId, 'stop').catch(() => {});
		await connection.deleteSnapshot('host', snapId, 'live');
		await connection.deleteSnapshot('host', snapId, 'before');
		expect(await connection.listSnapshots('host', snapId)).toEqual([]);
		await expect(connection.createSnapshot('host', snapId, 'bad name')).rejects.toMatchObject({ code: 'invalid' });
	}, 180_000);

	it('reports a shut down the guest ignores as a timeout, then powers off', async () => {
		await expect(connection.power('host', id, 'shutdown')).rejects.toMatchObject({ code: 'timeout' });
		await connection.power('host', id, 'stop');
		await until(async () => (await connection.listVms('host')).find((x) => x.id === id)?.state === 'stopped', 'stopped');
		await expect(connection.openConsole('host', id, 'vnc')).rejects.toMatchObject({ code: 'unavailable' });
	}, 60_000);

	it('deletes a domain, and a disk libvirt does not manage', async () => {
		await connection.deleteVm('host', id, { deleteDisks: true });
		expect((await connection.listVms('host')).find((x) => x.id === id)).toBeUndefined();
		if (image) {
			const snapId = (await connection.listVms('host')).find((x) => x.name === SNAP)!.id;
			await connection.deleteVm('host', snapId, { deleteDisks: true });
			expect(existsSync(join(dir, 'disk.qcow2'))).toBe(false);
		}
	}, 60_000);

	it('creates a domain through the provider, boots it and deletes it with its disk', async () => {
		const name = `${NAME}-new`;
		const schema = await connection.getCreateSchema('host');
		expect(schema.map((f) => f.key)).toEqual(expect.arrayContaining(['name', 'cpus', 'memoryMB', 'diskGB', 'pool', 'network']));
		try {
			const vm = await connection.createVm('host', { name, cpus: 1, memoryMB: 512, diskGB: 1, network: 'user', pool: String(schema.find((f) => f.key === 'pool')!.default ?? ''), diskBus: 'virtio', iso: join(dir, 'empty.iso') });
			expect(vm).toMatchObject({ name, state: 'stopped', cpus: 1, memoryMB: 512 });
			expect(vm.consoles).toEqual(['vnc', 'serial']);
			await connection.power('host', vm.id, 'start');
			await until(async () => (await connection.listVms('host')).find((x) => x.id === vm.id)?.state === 'running', 'running');
			const details = await connection.getVmDetails('host', vm.id);
			expect(details.disks.some((d) => d.id === 'vda')).toBe(true);
			await connection.power('host', vm.id, 'stop');
			await until(async () => (await connection.listVms('host')).find((x) => x.id === vm.id)?.state === 'stopped', 'stopped');
			await connection.deleteVm('host', vm.id, { deleteDisks: true });
			expect(v('vol-list', '--pool', String(schema.find((f) => f.key === 'pool')!.default || 'default'))).not.toContain(`${name}.qcow2`);
		} finally {
			try { v('destroy', name); } catch { /* not running */ }
			try { v('undefine', name, '--nvram', '--managed-save', '--storage', 'vda'); } catch { /* gone */ }
		}
	}, 120_000);
	it.runIf(!!image && /cloud/.test(image ?? ''))('creates a domain from a cloud image, cloud-init sets it up, and deletes it with its volumes', async () => {
		const name = `${NAME}-cloud`;
		const schema = await connection.getCreateSchema('host');
		const pool = String(schema.find((f) => f.key === 'pool')!.default || 'default');
		try {
			const vm = await connection.createVm('host', {
				name, source: 'cloud', cloudImage: 'custom', cloudImageFile: image, ciUser: 'vmm', ciPassword: 'vmm-e2e', ciAgent: true,
				cpus: 2, memoryMB: 1024, diskGB: 6, network: 'user', pool
			});
			const volumes = v('vol-list', '--pool', pool);
			expect(volumes).toContain(`${name}.qcow2`);
			expect(volumes).toContain(`${name}-cidata.iso`);
			expect(v('vol-dumpxml', '--pool', pool, `${name}.qcow2`)).toContain(`<capacity unit='bytes'>${6 * 1024 ** 3}</capacity>`);
			await connection.power('host', vm.id, 'start');
			// The agent only runs when cloud-init read the seed and installed it: proof the user-data was applied.
			await until(async () => { try { v('qemu-agent-command', name, '{"execute":"guest-ping"}'); return true; } catch { return false; } }, 'the guest agent', 6 * 60_000);
			const hostname = JSON.parse(v('qemu-agent-command', name, '{"execute":"guest-get-host-name"}')).return['host-name'];
			expect(hostname).toBe(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

			// User-mode networking: SSH is reached through a forward, which comes back after a restart.
			const port = 20000 + (process.pid % 20000);
			await connection.addPortForward!('host', vm.id, { protocol: 'tcp', hostPort: port, guestPort: 22 });
			expect((await connection.getVmDetails('host', vm.id)).forwards).toEqual([{ protocol: 'tcp', hostAddress: '127.0.0.1', hostPort: port, guestPort: 22 }]);
			const banner = () => new Promise<string>((resolve, reject) => {
				const socket = connect(port, '127.0.0.1');
				socket.once('data', (d) => { resolve(d.toString('latin1')); socket.destroy(); });
				socket.once('error', reject);
				setTimeout(() => { socket.destroy(); reject(new Error('no SSH banner')); }, 5000);
			});
			await until(async () => /^SSH-2\.0-/.test(await banner().catch(() => '')), 'the SSH banner through the forward', 60_000);
			await connection.power('host', vm.id, 'stop');
			await until(async () => (await connection.listVms('host')).find((x) => x.id === vm.id)?.state === 'stopped', 'stopped');
			await connection.power('host', vm.id, 'start');
			await until(async () => /^SSH-2\.0-/.test(await banner().catch(() => '')), 'the SSH banner after a restart', 3 * 60_000);
			await connection.removePortForward!('host', vm.id, { protocol: 'tcp', hostPort: port, guestPort: 22 });
			expect((await connection.getVmDetails('host', vm.id)).forwards).toEqual([]);
			await connection.power('host', vm.id, 'stop');
			await until(async () => (await connection.listVms('host')).find((x) => x.id === vm.id)?.state === 'stopped', 'stopped');
			await connection.deleteVm('host', vm.id, { deleteDisks: true });
			const after = v('vol-list', '--pool', pool);
			expect(after).not.toContain(`${name}.qcow2`);
			expect(after).not.toContain(`${name}-cidata.iso`);
		} finally {
			try { v('destroy', name); } catch { /* not running */ }
			try { v('undefine', name, '--nvram', '--managed-save', '--remove-all-storage'); } catch { /* gone */ }
		}
	}, 12 * 60_000);
});
