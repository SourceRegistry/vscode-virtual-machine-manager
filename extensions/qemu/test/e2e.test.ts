/**
 * Runs the provider against a real QEMU. Opt-in: `VMM_E2E_QEMU=1 npx vitest run extensions/qemu/test/e2e.test.ts`
 * (needs QEMU on PATH; uses TCG and an empty UEFI VM, so it needs no guest OS).
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, QemuProvider } from '../src/QemuProvider';

describe.skipIf(!process.env.VMM_E2E_QEMU)('QEMU provider end to end', () => {
	let dir: string;
	let connection: Awaited<ReturnType<QemuProvider['connect']>>;
	let vmId: string;
	let iso: string;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-e2e-'));
		const log = { info() {}, warn() {}, error() {}, debug() {} };
		const provider = new QemuProvider({ defaultQemuPath: () => undefined });
		connection = await provider.connect(
			{ id: 'c', name: 'c', providerId: 'qemu', config: { accelerator: 'tcg', shutdownTimeout: 5 } },
			{},
			{ storagePath: dir, log }
		);
		iso = path.join(dir, 'install.iso');
		fs.writeFileSync(iso, Buffer.alloc(2 * 1024 * 1024));
		const vm = await connection.createVm('local', { name: 'e2e', cpus: 1, memoryMB: 256, diskGB: 1, cdrom: iso, firmware: 'uefi', diskBus: 'sata', nic: 'none', serial: false });
		vmId = vm.id;
	}, 30_000);

	afterAll(async () => {
		await connection?.power('local', vmId, 'stop').catch(() => undefined);
		connection?.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const state = async () => (await connection.listVms('local')).find((v) => v.id === vmId)?.state;

	it('inventories hardware, samples stats, and ejects / inserts the ISO on a running VM', async () => {
		await connection.power('local', vmId, 'start');
		await new Promise((r) => setTimeout(r, 1500));
		const details = await connection.getVmDetails!('local', vmId);
		expect(details.disks.find((d) => d.kind === 'disk')).toMatchObject({ id: 'disk0', format: 'qcow2', sizeBytes: 1024 ** 3 });
		expect(details.disks.find((d) => d.kind === 'cdrom')).toMatchObject({ id: 'cd0', path: iso });
		expect(details.devices.some((d) => d.label === 'VGA controller')).toBe(true);
		expect(details.nics).toEqual([]); // nic: 'none'
		expect((await connection.listVms('local'))[0]).toMatchObject({ mediaInserted: true });

		await connection.ejectMedia!('local', vmId, 'cd0');
		expect((await connection.getVmDetails!('local', vmId)).disks.find((d) => d.id === 'cd0')?.path).toBeUndefined();
		expect((await connection.listVms('local'))[0]).toMatchObject({ mediaInserted: false });

		await connection.insertMedia!('local', vmId, 'cd0', iso);
		expect((await connection.getVmDetails!('local', vmId)).disks.find((d) => d.id === 'cd0')?.path).toBe(iso);

		const first = await connection.getVmStats!('local', vmId);
		expect(first.memoryUsedMB).toBeGreaterThan(0);
		expect(first.disks?.some((d) => d.id === 'disk0')).toBe(true);
		await new Promise((r) => setTimeout(r, 1200));
		const second = await connection.getVmStats!('local', vmId);
		expect(second.cpuUsage).toBeGreaterThanOrEqual(0);
		expect(second.cpuUsage).toBeLessThanOrEqual(1);

		await connection.power('local', vmId, 'stop');
		// Stopped: the definition remembers the media choice.
		expect((await connection.getVmDetails!('local', vmId)).disks.find((d) => d.id === 'cd0')?.path).toBe(iso);
		await connection.ejectMedia!('local', vmId, 'cd0');
		expect((await connection.listVms('local'))[0]).toMatchObject({ mediaInserted: false });
	}, 60_000);

	it('reports a timeout when the guest ignores the power button, then force-stops', async () => {
		await connection.power('local', vmId, 'start');
		expect(['running', 'starting']).toContain(await state());
		await new Promise((r) => setTimeout(r, 2000));

		const started = Date.now();
		await expect(connection.power('local', vmId, 'shutdown')).rejects.toMatchObject({ code: 'timeout' });
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(await state()).not.toBe('stopped'); // still up: the guest ignored ACPI

		await connection.power('local', vmId, 'stop');
		expect(await state()).toBe('stopped');
	}, 60_000);

	it('adds and removes a port forward on a running VM and remembers it', async () => {
		const nicVm = await connection.createVm('local', { name: 'e2e-net', cpus: 1, memoryMB: 256, diskGB: 1, firmware: 'uefi', diskBus: 'sata', nic: 'e1000', serial: false });
		const listening = (port: number) =>
			new Promise<boolean>((resolve) => {
				const socket = net.connect({ port, host: '127.0.0.1' });
				socket.once('connect', () => (socket.destroy(), resolve(true)));
				socket.once('error', () => resolve(false));
			});
		const hostPort = await freePort();
		try {
			await connection.power('local', nicVm.id, 'start');
			await new Promise((r) => setTimeout(r, 1500));
			expect(await listening(hostPort)).toBe(false);

			const forward = { protocol: 'tcp' as const, hostPort, guestPort: 22 };
			await connection.addPortForward!('local', nicVm.id, forward);
			expect(await listening(hostPort)).toBe(true);
			expect((await connection.getVmDetails!('local', nicVm.id)).forwards).toEqual([{ ...forward, hostAddress: '127.0.0.1' }]);
			await expect(connection.addPortForward!('local', nicVm.id, forward)).rejects.toMatchObject({ code: 'invalid' });

			await connection.removePortForward!('local', nicVm.id, forward);
			expect(await listening(hostPort)).toBe(false);
			expect((await connection.getVmDetails!('local', nicVm.id)).forwards).toEqual([]);
		} finally {
			await connection.power('local', nicVm.id, 'stop').catch(() => undefined);
		}
	}, 60_000);
});
