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
		const vm = await connection.createVm('local', { name: 'e2e', arch: 'x86_64', cpus: 1, memoryMB: 256, diskGB: 1, cdrom: iso, firmware: 'uefi', diskBus: 'sata', nic: 'none', serial: false });
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

	it('has a CD/DVD drive even without an ISO, and takes one inserted while the VM runs', async () => {
		const bare = await connection.createVm('local', { name: 'e2e-bare', arch: 'x86_64', cpus: 1, memoryMB: 256, diskGB: 1, firmware: 'uefi', diskBus: 'sata', nic: 'none', serial: false });
		const cd = async () => (await connection.getVmDetails!('local', bare.id)).disks.find((d) => d.kind === 'cdrom');
		try {
			expect(await cd()).toMatchObject({ id: 'cd0', path: undefined });
			expect((await connection.listVms('local')).find((v) => v.id === bare.id)).toMatchObject({ mediaInserted: false });

			await connection.power('local', bare.id, 'start');
			await new Promise((r) => setTimeout(r, 1500));
			expect(await cd()).toMatchObject({ id: 'cd0', path: undefined }); // the empty drive exists in the running VM

			await connection.insertMedia!('local', bare.id, 'cd0', iso);
			expect(await cd()).toMatchObject({ id: 'cd0', path: iso });
			expect((await connection.listVms('local')).find((v) => v.id === bare.id)).toMatchObject({ mediaInserted: true });

			await connection.ejectMedia!('local', bare.id, 'cd0');
			expect(await cd()).toMatchObject({ path: undefined });
		} finally {
			await connection.power('local', bare.id, 'stop').catch(() => undefined);
		}
	}, 60_000);

	it('clones a stopped VM into an independent copy, and refuses a running one or a name in use', async () => {
		const original = await connection.createVm('local', { name: 'e2e-orig', arch: 'x86_64', cpus: 2, memoryMB: 256, diskGB: 1, firmware: 'uefi', diskBus: 'sata', nic: 'e1000', serial: false });
		let copyId: string | undefined;
		try {
			const diskOf = async (id: string) => (await connection.getVmDetails!('local', id)).disks.find((d) => d.kind === 'disk')!.path!;
			const originalDisk = await diskOf(original.id);
			execFileSync('qemu-io', ['-c', 'write -P 0x5a 0 4k', originalDisk]);
			await connection.createSnapshot!('local', original.id, 'base');
			await connection.addPortForward!('local', original.id, { protocol: 'tcp', hostPort: 2299, guestPort: 22 });

			await expect(connection.cloneVm!('local', original.id, 'E2E-ORIG')).rejects.toMatchObject({ code: 'invalid' }); // name in use
			await expect(connection.cloneVm!('local', original.id, 'bad/name')).rejects.toMatchObject({ code: 'invalid' });

			const copy = await connection.cloneVm!('local', original.id, 'e2e-copy');
			copyId = copy.id;
			expect(copy).toMatchObject({ name: 'e2e-copy', state: 'stopped', cpus: 2, memoryMB: 256 });
			expect((await connection.listVms('local')).map((v) => v.name)).toEqual(expect.arrayContaining(['e2e-orig', 'e2e-copy']));

			// Its own disk, with the original's data but not its snapshots.
			const copyDisk = await diskOf(copy.id);
			expect(copyDisk).not.toBe(originalDisk);
			execFileSync('qemu-io', ['-r', '-c', 'read -P 0x5a 0 4k', copyDisk]);
			expect(await connection.listSnapshots!('local', copy.id)).toEqual([]);
			expect((await connection.listSnapshots!('local', original.id)).map((s) => s.name)).toEqual(['base']);

			// Its own identity: new MAC, and no port forwards (the host port would clash).
			const macOf = async (id: string) => (await connection.getVmDetails!('local', id)).nics[0]?.mac;
			expect(await macOf(copy.id)).toBeTruthy();
			expect(await macOf(copy.id)).not.toBe(await macOf(original.id));
			expect((await connection.getVmDetails!('local', copy.id)).forwards).toEqual([]);
			expect((await connection.getVmDetails!('local', original.id)).forwards).toHaveLength(1);

			// Independent: writing to the copy leaves the original alone.
			execFileSync('qemu-io', ['-c', 'write -P 0x77 0 4k', copyDisk]);
			execFileSync('qemu-io', ['-r', '-c', 'read -P 0x5a 0 4k', originalDisk]);

			// A running VM cannot be cloned.
			await connection.power('local', original.id, 'start');
			await new Promise((r) => setTimeout(r, 1500));
			await expect(connection.cloneVm!('local', original.id, 'e2e-copy-2')).rejects.toMatchObject({ code: 'invalid' });
			expect((await connection.listVms('local')).map((v) => v.name)).not.toContain('e2e-copy-2');
		} finally {
			await connection.power('local', original.id, 'stop').catch(() => undefined);
		}
	}, 120_000);

	it('turns a stopped VM into a template that cannot start, and clones it into a machine', async () => {
		const base = await connection.createVm('local', { name: 'e2e-tpl', arch: 'x86_64', cpus: 1, memoryMB: 256, diskGB: 1, firmware: 'uefi', diskBus: 'sata', nic: 'none', serial: false });
		const flag = async (id: string) => (await connection.listVms('local')).find((v) => v.id === id)?.template;
		await connection.setTemplate!('local', base.id, true);
		expect(await flag(base.id)).toBe(true);
		await expect(connection.power('local', base.id, 'start')).rejects.toMatchObject({ code: 'invalid' });
		const made = await connection.cloneVm!('local', base.id, 'e2e-from-tpl');
		expect(await flag(made.id)).toBeFalsy();
		expect(await flag(base.id)).toBe(true);
		await connection.setTemplate!('local', base.id, false);
		expect(await flag(base.id)).toBeFalsy();
	}, 60_000);

	it('snapshots a stopped and a running VM, refuses to revert a running one, and reverts a stopped one', async () => {
		const snapVm = await connection.createVm('local', { name: 'e2e-snap', arch: 'x86_64', cpus: 1, memoryMB: 256, diskGB: 1, firmware: 'uefi', diskBus: 'sata', nic: 'none', serial: false });
		const names = async () => (await connection.listSnapshots!('local', snapVm.id)).map((s) => s.name);
		try {
			expect(await names()).toEqual([]);

			// Stopped: qemu-img.
			await connection.createSnapshot!('local', snapVm.id, 'cold');
			expect(await names()).toEqual(['cold']);
			await expect(connection.createSnapshot!('local', snapVm.id, 'COLD')).rejects.toMatchObject({ code: 'invalid' });
			await expect(connection.createSnapshot!('local', snapVm.id, 'bad/name')).rejects.toMatchObject({ code: 'invalid' });

			// Running: QMP, disk state only. The listing comes from QEMU, and still shows the stopped one.
			await connection.power('local', snapVm.id, 'start');
			await new Promise((r) => setTimeout(r, 1500));
			const live = await connection.createSnapshot!('local', snapVm.id, 'live');
			expect(live).toMatchObject({ id: 'live', includesMemory: false });
			expect(await names()).toEqual(['cold', 'live']);
			await expect(connection.revertSnapshot!('local', snapVm.id, 'cold')).rejects.toMatchObject({ code: 'invalid' });
			await connection.deleteSnapshot!('local', snapVm.id, 'live');
			expect(await names()).toEqual(['cold']);

			// Stopped again: the snapshot taken while stopped is still there and can be reverted to, then deleted.
			await connection.power('local', snapVm.id, 'stop');
			expect(await names()).toEqual(['cold']);
			// Data written after the snapshot must be gone after the revert (checked on the image itself).
			const disk = (await connection.getVmDetails!('local', snapVm.id)).disks.find((d) => d.kind === 'disk')!.path!;
			const readBack = () => execFileSync('qemu-io', ['-r', '-c', 'read -P 0xab 0 4k', disk]).toString();
			execFileSync('qemu-io', ['-c', 'write -P 0xab 0 4k', disk]);
			expect(readBack()).toContain('read 4096/4096 bytes');
			await connection.revertSnapshot!('local', snapVm.id, 'cold');
			expect(() => readBack()).toThrow(/Command failed/); // qemu-io exits non-zero when the pattern is not there
			await expect(connection.revertSnapshot!('local', snapVm.id, 'missing')).rejects.toMatchObject({ code: 'notFound' });
			await connection.deleteSnapshot!('local', snapVm.id, 'cold');
			expect(await names()).toEqual([]);
		} finally {
			await connection.power('local', snapVm.id, 'stop').catch(() => undefined);
		}
	}, 90_000);

	it('adds and removes a port forward on a running VM and remembers it', async () => {
		const nicVm = await connection.createVm('local', { name: 'e2e-net', arch: 'x86_64', cpus: 1, memoryMB: 256, diskGB: 1, firmware: 'uefi', diskBus: 'sata', nic: 'e1000', serial: false });
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

	it.skipIf(process.arch !== 'arm64')('boots an empty ARM64 UEFI VM natively, with a CD that can be ejected and inserted', async () => {
		const arm = await connection.createVm('local', { name: 'e2e-arm', arch: 'aarch64', cpus: 2, memoryMB: 512, diskGB: 1, cdrom: iso, firmware: 'bios', diskBus: 'sata', nic: 'e1000', serial: false });
		try {
			// x86 form defaults were replaced by what the ARM machine has
			const config = await connection.getVmConfig('local', arm.id);
			expect(config.values).toMatchObject({ firmware: 'uefi', diskBus: 'virtio', nic: 'virtio-net-pci', vga: 'virtio' });
			expect(String(config.values.arch)).toContain('ARM64');
			expect(config.schema.find((f) => f.key === 'firmware')).toMatchObject({ readonly: true });

			await connection.power('local', arm.id, 'start');
			await new Promise((r) => setTimeout(r, 2500));
			expect((await connection.listVms('local')).find((v) => v.id === arm.id)).toMatchObject({ state: 'running', mediaInserted: true });
			const details = await connection.getVmDetails!('local', arm.id);
			expect(details.disks.find((d) => d.kind === 'disk')).toMatchObject({ format: 'qcow2' });
			expect(details.disks.find((d) => d.kind === 'cdrom')).toMatchObject({ id: 'cd0', path: iso });
			expect(details.devices.some((d) => /virtio/i.test(d.label) || /display|vga|3d/i.test(d.label))).toBe(true);

			await connection.ejectMedia!('local', arm.id, 'cd0');
			expect((await connection.getVmDetails!('local', arm.id)).disks.find((d) => d.id === 'cd0')?.path).toBeUndefined();
			await connection.insertMedia!('local', arm.id, 'cd0', iso);
			expect((await connection.getVmDetails!('local', arm.id)).disks.find((d) => d.id === 'cd0')?.path).toBe(iso);
			expect((await connection.getVmStats!('local', arm.id)).memoryUsedMB).toBeGreaterThan(0);
		} finally {
			await connection.power('local', arm.id, 'stop').catch(() => undefined);
		}
	}, 90_000);

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

	it('adds, grows, converts, exports and removes disks', async () => {
		const MB = 1024 ** 2;
		const disks = async () => (await connection.getVmDetails!('local', vmId)).disks.filter((d) => d.kind === 'disk');
		const info = (file: string) => JSON.parse(execFileSync('qemu-img', ['info', '--output=json', file], { encoding: 'utf8' })) as { format: string; 'virtual-size': number };
		if ((await state()) !== 'stopped') await connection.power('local', vmId, 'stop');

		// A snapshot taken before a disk is added still covers the machine afterwards.
		await connection.createSnapshot!('local', vmId, 'before');
		const added = await connection.addDisk!('local', vmId, { sizeBytes: 64 * MB });
		expect(added).toMatchObject({ id: 'disk1', format: 'qcow2', sizeBytes: 64 * MB });
		expect((await connection.listSnapshots!('local', vmId)).map((s) => s.name)).toEqual(['before']);
		expect((await disks())[1]).toMatchObject({ id: 'disk1', sizeBytes: 64 * MB, format: 'qcow2' });
		expect((await disks())[1]!.allocatedBytes).toBeGreaterThan(0);
		await expect(connection.addDisk!('local', vmId, { sizeBytes: 64 * MB, format: 'raw' })).rejects.toThrow(/snapshots/);
		await expect(connection.convertDisk!('local', vmId, 'disk1', 'raw')).rejects.toThrow(/delete the 1 snapshot/);
		await connection.deleteSnapshot!('local', vmId, 'before');

		// SATA: five disks at most.
		for (let n = 2; n < 5; n++) await connection.addDisk!('local', vmId, { sizeBytes: 8 * MB, format: 'raw' });
		await expect(connection.addDisk!('local', vmId, { sizeBytes: 8 * MB })).rejects.toThrow(/SATA controller holds 5/);
		for (const id of ['disk4', 'disk3', 'disk2']) {
			const file = (await disks()).find((d) => d.id === id)!.path!;
			await connection.removeDisk!('local', vmId, id, { deleteFile: true });
			expect(fs.existsSync(file)).toBe(false);
		}

		// Grow while stopped; never shrink.
		await connection.resizeDisk!('local', vmId, 'disk1', 128 * MB);
		expect((await disks())[1]!.sizeBytes).toBe(128 * MB);
		await expect(connection.resizeDisk!('local', vmId, 'disk1', 64 * MB)).rejects.toThrow(/only grow/);

		// Convert to raw and back; compact in place.
		const qcow = (await disks())[1]!.path!;
		await connection.convertDisk!('local', vmId, 'disk1', 'raw');
		const raw = (await disks())[1]!;
		expect(raw).toMatchObject({ format: 'raw', sizeBytes: 128 * MB });
		expect(raw.path).toMatch(/\.img$/);
		expect(fs.existsSync(qcow)).toBe(false);
		await connection.convertDisk!('local', vmId, 'disk1', 'qcow2');
		await connection.convertDisk!('local', vmId, 'disk1', 'qcow2');
		expect((await disks())[1]).toMatchObject({ path: qcow, format: 'qcow2', sizeBytes: 128 * MB });
		expect(fs.readdirSync(path.dirname(qcow)).filter((f) => f.includes('converting'))).toEqual([]);

		// Export to the formats of other hypervisors.
		for (const [format, ext] of [['vmdk', 'vmdk'], ['vhdx', 'vhdx'], ['vdi', 'vdi'], ['raw', 'img']] as const) {
			const target = path.join(dir, `export.${ext}`);
			await connection.exportDisk!('local', vmId, 'disk1', target, { format });
			expect(info(target)).toMatchObject({ format, 'virtual-size': 128 * MB });
		}
		const compressed = path.join(dir, 'export-c.qcow2');
		await connection.exportDisk!('local', vmId, 'disk1', compressed, { format: 'qcow2', compress: true });
		expect(info(compressed).format).toBe('qcow2');

		// Running: grow through QMP, everything else waits for a shut down.
		await connection.power('local', vmId, 'start');
		await new Promise((r) => setTimeout(r, 1500));
		await connection.resizeDisk!('local', vmId, 'disk1', 256 * MB);
		expect((await disks())[1]!.sizeBytes).toBe(256 * MB);
		await expect(connection.addDisk!('local', vmId, { sizeBytes: 8 * MB })).rejects.toThrow(/Shut down/);
		await expect(connection.exportDisk!('local', vmId, 'disk1', path.join(dir, 'x.qcow2'), { format: 'qcow2' })).rejects.toThrow(/Shut down/);
		await connection.power('local', vmId, 'stop');

		// Remove, keeping the file.
		await connection.removeDisk!('local', vmId, 'disk1', { deleteFile: false });
		expect((await disks()).map((d) => d.id)).toEqual(['disk0']);
		expect(fs.existsSync(qcow)).toBe(true);

		// Attach image files: a VMDK copied (as qcow2), a qcow2 used where it is.
		const vmdk = path.join(dir, 'other.vmdk');
		execFileSync('qemu-img', ['create', '-q', '-f', 'vmdk', vmdk, '48M']);
		const copied = await connection.attachDisk!('local', vmId, vmdk, { copy: true });
		expect(copied).toMatchObject({ id: 'disk1', format: 'qcow2', sizeBytes: 48 * MB });
		expect(copied.path).not.toBe(vmdk);
		expect(info(copied.path!).format).toBe('qcow2');
		expect(fs.existsSync(vmdk)).toBe(true);
		const inPlace = path.join(dir, 'shared.qcow2');
		execFileSync('qemu-img', ['create', '-q', '-f', 'qcow2', inPlace, '32M']);
		expect(await connection.attachDisk!('local', vmId, inPlace, { copy: false })).toMatchObject({ id: 'disk2', path: inPlace, format: 'qcow2' });
		await expect(connection.attachDisk!('local', vmId, inPlace, { copy: false })).rejects.toThrow(/already a disk of e2e/);
		// A qcow2 named like a raw image would be written over as raw.
		const misnamed = path.join(dir, 'misnamed.img');
		execFileSync('qemu-img', ['create', '-q', '-f', 'qcow2', misnamed, '8M']);
		await expect(connection.attachDisk!('local', vmId, misnamed, { copy: false })).rejects.toThrow(/file name says raw, but the image is qcow2/);
		await expect(connection.attachDisk!('local', vmId, path.join(dir, 'missing.qcow2'), { copy: true })).rejects.toThrow(/not found/);
		// With snapshots only a copy can join them.
		await connection.createSnapshot!('local', vmId, 'attach');
		const fresh = path.join(dir, 'fresh.qcow2');
		execFileSync('qemu-img', ['create', '-q', '-f', 'qcow2', fresh, '8M']);
		await expect(connection.attachDisk!('local', vmId, fresh, { copy: false })).rejects.toThrow(/snapshots/);
		expect((await connection.attachDisk!('local', vmId, misnamed, { copy: true })).format).toBe('qcow2');
		expect((await connection.listSnapshots!('local', vmId)).map((x) => x.name)).toEqual(['attach']);
		await connection.deleteSnapshot!('local', vmId, 'attach');
		await connection.removeDisk!('local', vmId, 'disk3', { deleteFile: true });
		await connection.removeDisk!('local', vmId, 'disk2', { deleteFile: false });
		await connection.removeDisk!('local', vmId, 'disk1', { deleteFile: true });
		expect(fs.existsSync(inPlace)).toBe(true);
		expect((await disks()).map((d) => d.id)).toEqual(['disk0']);
	}, 120_000);
});
