/**
 * End to end against a Linux libvirt host (`VMM_E2E_LIBVIRT_URI`, a `qemu+ssh://` or `qemu:///system` URI virsh can open
 * without prompts). Defines a throw-away domain, drives it through the provider and removes it, and the pool it made.
 * Runs on any host: with no KVM the guest is emulated, so nothing here waits for it to boot.
 */
import { describe, expect, it } from 'vitest';
import type { ClusterConfig, ProviderContext } from '@vmm/sdk';
import { LibvirtProvider } from '../src/LibvirtProvider';
import { findVirsh } from '../src/virsh';

const uri = process.env.VMM_E2E_LIBVIRT_URI;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const context = { log, storagePath: '/tmp' } as unknown as ProviderContext;
const cluster: ClusterConfig = { id: 'e2e', name: 'e2e', providerId: 'libvirt', config: { connection: 'custom', uri: uri ?? '', shutdownTimeout: 5 } };
const NAME = `vmm-e2e-${process.pid}`;
const until = async (check: () => Promise<boolean>, what: string, ms = 30_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 500)); }
	throw new Error(`Timed out waiting for ${what}`);
};

describe.skipIf(!uri || !findVirsh())('libvirt provider against a Linux host', () => {
	it('connects, describes the host, creates, starts, snapshots-free lifecycle, and deletes with the disk', async () => {
		const connection = await new LibvirtProvider().connect(cluster, {}, context);
		try {
			const [node] = await connection.listNodes();
			expect(node).toMatchObject({ status: 'online' });
			expect(connection.capabilities.remotePaths).toBe(!/^qemu:\/\/\//.test(uri!));
			const schema = await connection.getCreateSchema('host');
			const pool = schema.find((f) => f.key === 'pool')!;
			expect(pool.options!.length).toBeGreaterThan(0);
			const vm = await connection.createVm('host', { name: NAME, cpus: 1, memoryMB: 256, diskGB: 1, network: 'user', pool: String(pool.default ?? ''), diskBus: 'virtio' });
			expect(vm).toMatchObject({ name: NAME, state: 'stopped', memoryMB: 256 });
			expect(vm.consoles).toContain('vnc');
			await connection.power('host', vm.id, 'start');
			await until(async () => (await connection.listVms('host')).find((x) => x.id === vm.id)?.state === 'running', 'running');
			const details = await connection.getVmDetails('host', vm.id);
			expect(details.disks.some((d) => d.id === 'vda')).toBe(true);
			// Over ssh the display and the stats are read through the tunnel and virsh alone.
			expect((await connection.getVmStats('host', vm.id)).memoryMB).toBe(256);
			const stream = await connection.openConsole('host', vm.id, 'vnc');
			// A VNC server speaks first: the banner proves the tunnel (or the loopback port) reaches it.
			const banner = await new Promise<string>((resolve, reject) => { const t = setTimeout(() => reject(new Error('no VNC banner')), 15_000); stream.stream.once('data', (d: Buffer) => { clearTimeout(t); resolve(d.toString('latin1', 0, 3)); }); });
			expect(banner).toBe('RFB');
			stream.dispose();
			await connection.power('host', vm.id, 'stop');
			await until(async () => (await connection.listVms('host')).find((x) => x.id === vm.id)?.state === 'stopped', 'stopped');
			await connection.deleteVm('host', vm.id, { deleteDisks: true });
			expect((await connection.listVms('host')).find((x) => x.id === vm.id)).toBeUndefined();
		} finally {
			// A failed run must not leave a domain and a disk on the host.
			const left = (await connection.listVms('host').catch(() => [])).find((x) => x.name === NAME);
			if (left) await connection.deleteVm('host', left.id, { deleteDisks: true }).catch(() => undefined);
			connection.dispose();
		}
	}, 180_000);
});
