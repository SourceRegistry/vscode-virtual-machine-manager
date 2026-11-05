/**
 * Runs the provider against a real QEMU. Opt-in: `VMM_E2E_QEMU=1 npx vitest run extensions/qemu/test/e2e.test.ts`
 * (needs QEMU on PATH; uses TCG and an empty UEFI VM, so it needs no guest OS).
 */
import { execFileSync, spawn } from 'node:child_process';
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

	it('reports passthrough support and handles a USB device that does not exist', async () => {
		await connection.power('local', vmId, 'start');
		await new Promise((r) => setTimeout(r, 1500));
		try {
			const info = await connection.getPassthrough!('local', vmId);
			if (process.platform === 'linux') expect(info.pci.experimental).toBe(true);
			else expect(info.pci).toMatchObject({ supported: false });
			expect(info.devices.every((d) => d.kind === 'usb' || d.kind === 'pci')).toBe(true);

			// A device the host does not have is refused up front (QEMU itself would wait for it to appear).
			await expect(connection.planPassthrough!('local', vmId, 'usb:dead:beef', 'attach')).rejects.toMatchObject({ code: 'notFound' });
			await expect(connection.changePassthrough!('local', vmId, 'usb:dead:beef', 'attach', { confirmed: false })).rejects.toMatchObject({ code: 'notFound' });
			const real = info.devices.find((d) => d.kind === 'usb' && !d.unavailable);
			if (real) {
				const plan = await connection.planPassthrough!('local', vmId, real.id, 'attach');
				expect(plan).toMatchObject({ needsConfirmation: false });
				expect(plan.steps[0]).toContain('device_add usb-host');
			}
			// PCI: never without the user's confirmation, and never while the VM runs.
			await expect(connection.planPassthrough!('local', vmId, 'pci:0000:00:02.0', 'attach')).rejects.toBeDefined();
			await expect(connection.changePassthrough!('local', vmId, 'pci;rm -rf /', 'attach', { confirmed: true })).rejects.toMatchObject({ code: 'invalid' });
		} finally {
			await connection.power('local', vmId, 'stop').catch(() => undefined);
		}
	}, 60_000);

	describe.skipIf(process.platform === 'win32')('QEMU started outside the extension', () => {
		let child: ReturnType<typeof spawn> | undefined;
		afterAll(() => child?.kill('SIGKILL'));

		it('is found by the scan, attached, observed, imported by folder and powered off', async () => {
			const socket = path.join(dir, 'outside.sock');
			const disk = path.join(dir, 'outside.qcow2');
			execFileSync('qemu-img', ['create', '-f', 'qcow2', disk, '64M']);
			child = spawn('qemu-system-x86_64', ['-name', 'outside-vm', '-machine', 'q35', '-accel', 'tcg', '-m', '128', '-smp', '1', '-display', 'none', '-drive', `file=${disk},if=none,id=d0,format=qcow2`, '-device', 'ide-hd,drive=d0,bus=ide.0', '-qmp', `unix:${socket},server=on,wait=off`], { stdio: 'ignore' });
			for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));

			const found = (await connection.scanExternalVms!('local')).find((v) => v.name === 'outside-vm');
			expect(found).toMatchObject({ id: String(child.pid), controllable: true });

			const { vm, warning } = await connection.adoptExternalVm!('local', found!.id);
			expect(warning).toBeUndefined();
			expect(vm).toMatchObject({ name: 'outside-vm', origin: 'adopted', state: 'running', controllable: true });
			// attached once: no longer offered
			expect((await connection.scanExternalVms!('local')).some((v) => v.name === 'outside-vm')).toBe(false);

			const listed = (await connection.listVms('local')).find((v) => v.id === vm.id);
			expect(listed).toMatchObject({ state: 'running', origin: 'adopted', consoles: [] });
			const details = await connection.getVmDetails!('local', vm.id);
			expect(details.disks.find((d) => d.kind === 'disk')?.format).toBe('qcow2');
			expect((await connection.getVmStats!('local', vm.id)).memoryUsedMB).toBeGreaterThan(0);

			// A bare guest ignores ACPI: the ladder times out, then the confirmed power off ends the process.
			await expect(connection.power('local', vm.id, 'shutdown')).rejects.toMatchObject({ code: 'timeout' });
			await connection.power('local', vm.id, 'stop');
			for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await new Promise((r) => setTimeout(r, 100));
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
			// An adopted VM is gone from the list once its process is.
			expect((await connection.listVms('local')).some((v) => v.id === vm.id)).toBe(false);

			// The same disk is now offered for import from its folder, referenced rather than copied.
			const candidates = await connection.scanImportFolder!('local', dir);
			const candidate = candidates.find((c) => c.name === 'outside');
			expect(candidate).toBeDefined();
			const [imported] = await connection.importFromFolder!('local', dir, [candidate!.id], { copy: false });
			expect(imported).toMatchObject({ name: 'outside', origin: 'imported', state: 'stopped' });
			expect((await connection.getVmDetails!('local', imported!.id)).disks[0]).toMatchObject({ path: disk });
			// ...and not offered again.
			expect((await connection.scanImportFolder!('local', dir)).some((c) => c.id === candidate!.id)).toBe(false);
			await connection.deleteVm('local', imported!.id, { deleteDisks: false });
			expect(fs.existsSync(disk)).toBe(true);
		}, 90_000);
	});
});
