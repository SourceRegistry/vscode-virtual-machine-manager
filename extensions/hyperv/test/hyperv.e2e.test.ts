/**
 * Runs the provider against a real Hyper-V. Opt-in: `VMM_E2E_HYPERV=1 npx vitest run extensions/hyperv/test/hyperv.e2e.test.ts`
 * (Windows with Hyper-V; the account must be in "Hyper-V Administrators"). Creates its own Generation 2 VM named
 * `vmm-e2e-<random>` with a 1 GB disk in a temporary folder and no network, never touches other VMs, and removes
 * everything it made afterwards. Needs no guest OS: the VM boots into its firmware.
 *
 * Every read right after a change is checked without waiting: the provider reads (and changes media) through CIM.
 * The Hyper-V cmdlets answer from a cache that WMI events update about 4.5 s late, which a waiting test would hide.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIso } from '@vmm/sdk/provisioning';
import { HyperVProvider, type HyperVConnection } from '../src/HyperVProvider';

const enabled = process.platform === 'win32' && !!process.env.VMM_E2E_HYPERV;
const NODE = 'local';
const PREFIX = 'vmm-e2e-';

/** Removes every VM this run created, whatever state the tests left them in. */
function cleanup(names: string[]): void {
	const list = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
	const script = `foreach ($n in @(${list})) { Get-VM -Name $n -ErrorAction SilentlyContinue | ForEach-Object { $disks = @(Get-VMHardDiskDrive -VM $_ | ForEach-Object { $_.Path }); Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -VM $_ -Force; $disks | Where-Object { $_ } | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue } } }`;
	try {
		execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 120_000 });
	} catch {
		// Best effort.
	}
}

describe.skipIf(!enabled)('Hyper-V provider end to end', () => {
	const tag = Math.random().toString(36).slice(2, 8);
	const name = `${PREFIX}${tag}`;
	const cloneName = `${PREFIX}${tag}-copy`;
	const logs: string[] = [];
	const log = {
		info: (m: string) => logs.push(`info ${m}`),
		warn: (m: string) => logs.push(`warn ${m}`),
		error: (m: string) => logs.push(`error ${m}`),
		debug: (m: string) => logs.push(`debug ${m}`)
	};
	let dir: string;
	let iso: string;
	let connection: HyperVConnection;
	let vmId: string;

	const vm = async (id = vmId) => (await connection.listVms()).find((v) => v.id === id);
	const config = async (id = vmId) => (await connection.getVmConfig(NODE, id)).values;
	const dvdPath = async (id: string) => (await connection.getVmDetails!(NODE, vmId)).disks.find((d) => d.id === id)?.path;
	const waitFor = async (check: () => Promise<boolean>, ms = 60_000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (await check()) return;
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error('timed out');
	};

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-hyperv-e2e-'));
		iso = path.join(dir, 'media.iso');
		fs.writeFileSync(iso, buildIso([{ name: 'hello.txt', data: Buffer.from('hello from vmm\n') }], { volumeId: 'VMME2E' }));
		connection = await new HyperVProvider().connect({ id: 'c', name: 'c', providerId: 'hyperv', config: {} }, {}, { storagePath: dir, log });
		const created = await connection.createVm(NODE, {
			name,
			cpus: 1,
			memoryMB: 512,
			diskGB: 1,
			generation: '2',
			secureBoot: 'off',
			iso,
			dynamicMemory: true,
			serial: true,
			vhdDirectory: dir,
			notes: 'created by the VM Manager end-to-end test'
		});
		vmId = created.id;
		// Windows 10/11 take an automatic checkpoint at every start; the checkpoint tests count them.
		execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-VM -Id '${vmId}' | Set-VM -AutomaticCheckpointsEnabled $false`], { stdio: 'ignore', timeout: 60_000 });
	}, 5 * 60_000);

	afterAll(() => {
		connection?.dispose();
		cleanup([name, cloneName, `${name}-renamed`]);
		fs.rmSync(dir, { recursive: true, force: true });
		if (logs.some((l) => l.startsWith('warn') || l.startsWith('error'))) console.log(logs.filter((l) => !l.startsWith('debug')).join('\n'));
	}, 5 * 60_000);

	it('describes the host', async () => {
		const [node] = await connection.listNodes();
		expect(node).toMatchObject({ id: NODE, status: 'online', name: os.hostname().toUpperCase() });
		expect(node.cpus).toBeGreaterThan(0);
		expect(node.memoryMB).toBeGreaterThan(node.memoryUsedMB ?? 0);
		expect(node.cpuUsage).toBeGreaterThanOrEqual(0);
		expect(node.cpuUsage).toBeLessThanOrEqual(1);
		expect(node.facts?.find((f) => f.label === 'Hyper-V host')?.value).toMatch(/Windows/);
		expect(node.facts?.find((f) => f.label === 'VM storage')?.value).toBeTruthy();
	}, 60_000);

	it('lists the new machine with its console and media', async () => {
		expect(await vm()).toMatchObject({
			name,
			state: 'stopped',
			cpus: 1,
			memoryMB: 512,
			os: 'Generation 2',
			description: 'created by the VM Manager end-to-end test',
			consoles: ['rdp', 'serial'],
			mediaInserted: true
		});
	}, 60_000);

	it('offers the switches in the create form', async () => {
		const schema = await connection.getCreateSchema();
		const switches = schema.find((f) => f.key === 'switch');
		expect(switches?.type).toBe('select');
		expect(Array.isArray(switches?.options)).toBe(true);
	}, 60_000);

	it('reads and changes the configuration', async () => {
		const before = await connection.getVmConfig(NODE, vmId);
		expect(before.values).toMatchObject({
			name,
			generation: 2,
			cpus: 1,
			memoryMB: 512,
			dynamicMemory: true,
			iso,
			serial: true,
			secureBoot: 'off',
			notes: 'created by the VM Manager end-to-end test'
		});
		expect(String(before.values.disks)).toContain(path.join(dir, `${name}.vhdx`));

		await connection.updateVm(NODE, vmId, { ...before.values, cpus: 2, memoryMB: 768, dynamicMemory: false, notes: 'changed', autoStart: 'Nothing', secureBoot: 'MicrosoftUEFICertificateAuthority' });
		expect(await config()).toMatchObject({ cpus: 2, memoryMB: 768, dynamicMemory: false, notes: 'changed', autoStart: 'Nothing', secureBoot: 'MicrosoftUEFICertificateAuthority', iso });
		const after = await config();

		// Rename and back.
		await connection.updateVm(NODE, vmId, { ...after, name: `${name}-renamed` });
		expect((await vm())?.name).toBe(`${name}-renamed`);
		await connection.updateVm(NODE, vmId, { ...after, name, secureBoot: 'off', dynamicMemory: true, memoryMB: 512, cpus: 1, notes: 'created by the VM Manager end-to-end test' });
		expect(await config()).toMatchObject({ name, cpus: 1, memoryMB: 512, dynamicMemory: true, secureBoot: 'off', notes: 'created by the VM Manager end-to-end test' });
	}, 3 * 60_000);

	it('inventories disks, the DVD drive and the network adapter', async () => {
		const details = await connection.getVmDetails!(NODE, vmId);
		const disk = details.disks.find((d) => d.kind === 'disk');
		expect(disk).toMatchObject({ id: 'SCSI:0:0', path: path.join(dir, `${name}.vhdx`), sizeBytes: 1024 ** 3, format: 'vhdx', bus: 'scsi' });
		const dvd = details.disks.find((d) => d.kind === 'cdrom');
		expect(dvd).toMatchObject({ path: iso, format: 'iso', removable: true, sizeBytes: fs.statSync(iso).size });
		expect(details.nics).toHaveLength(1);
		expect(details.nics[0]).toMatchObject({ network: 'Not connected', model: 'Synthetic network adapter' });
	}, 60_000);

	it('ejects and inserts the ISO on a stopped machine', async () => {
		const dvd = (await connection.getVmDetails!(NODE, vmId)).disks.find((d) => d.kind === 'cdrom')!;
		await connection.ejectMedia!(NODE, vmId, dvd.id);
		expect(await dvdPath(dvd.id)).toBeUndefined();
		expect((await vm())?.mediaInserted).toBe(false);
		await connection.insertMedia!(NODE, vmId, dvd.id, iso);
		expect(await dvdPath(dvd.id)).toBe(iso);
		expect((await vm())?.mediaInserted).toBe(true);
		await expect(connection.insertMedia!(NODE, vmId, dvd.id, path.join(dir, 'missing.iso'))).rejects.toThrow(/Image not found/);
		await expect(connection.ejectMedia!(NODE, vmId, 'SCSI:9:9')).rejects.toThrow(/not found/);
	}, 2 * 60_000);

	it('reports device assignment as unsupported on a client Windows', async () => {
		const info = await connection.getPassthrough!(NODE, vmId);
		const server = (execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).ProductType'], { encoding: 'utf8' }).trim()) !== '1';
		if (!server) {
			expect(info.pci.supported).toBe(false);
			expect(info.pci.reason).toBeTruthy();
		}
	}, 2 * 60_000);

	it('starts, samples stats, shows a preview and swaps media while running', async () => {
		await connection.power(NODE, vmId, 'start');
		await waitFor(async () => (await vm())?.state === 'running');
		const running = (await vm())!;
		expect(running.uptimeSeconds ?? 0).toBeGreaterThanOrEqual(0);

		await new Promise((r) => setTimeout(r, 2000));
		const stats = await connection.getVmStats!(NODE, vmId);
		expect(stats.cpuUsage).toBeGreaterThanOrEqual(0);
		expect(stats.cpuUsage).toBeLessThanOrEqual(1);
		expect(stats.memoryMB).toBeGreaterThan(0);
		expect(stats.memoryUsedMB).toBeGreaterThan(0);

		const abort = new AbortController();
		const frames = connection.openPreview(NODE, vmId, abort.signal)[Symbol.asyncIterator]();
		const frame = (await frames.next()).value;
		abort.abort();
		expect(frame).toMatchObject({ format: 'rgb565' });
		expect(frame.width).toBeGreaterThan(0);
		// Hyper-V adds a few bytes after the pixels; the preview reads width x height x 2.
		expect(frame.data.length).toBeGreaterThanOrEqual(frame.width * frame.height * 2);

		const dvd = (await connection.getVmDetails!(NODE, vmId)).disks.find((d) => d.kind === 'cdrom')!;
		await connection.ejectMedia!(NODE, vmId, dvd.id);
		expect((await vm())?.mediaInserted).toBe(false);
		await connection.insertMedia!(NODE, vmId, dvd.id, iso);
		expect((await vm())?.mediaInserted).toBe(true);
	}, 3 * 60_000);

	it('opens the VMConnect console and reports what the serial pipe allows', async () => {
		const rdp = await connection.openConsole(NODE, vmId, 'rdp');
		rdp.dispose();
		expect(rdp.stream).toBeInstanceOf(net.Socket);

		const target = await connection.getRdpTarget!(NODE, vmId);
		expect(target).toMatchObject({ serverName: os.hostname(), vmConnect: { vmId, mode: 'basic' } });
		expect(target.defaultUsername).toBeTruthy();

		// Hyper-V only lets administrators open the COM pipe; either it connects, or the error says why.
		try {
			const serial = await connection.openConsole(NODE, vmId, 'serial');
			serial.dispose();
		} catch (error) {
			expect((error as Error).message).toMatch(/administrator/);
		}
	}, 60_000);

	it('takes, lists, reverts and deletes checkpoints on a running machine', async () => {
		const first = await connection.createSnapshot!(NODE, vmId, 'first');
		expect(first.name).toBe('first');
		await expect(connection.createSnapshot!(NODE, vmId, 'first')).rejects.toThrow(/already exists/);
		const second = await connection.createSnapshot!(NODE, vmId, 'second');
		expect((await connection.listSnapshots!(NODE, vmId)).map((s) => s.name)).toEqual(['first', 'second']);
		const list = await connection.listSnapshots!(NODE, vmId);
		expect(list.map((s) => s.id)).toEqual([first.id, second.id]);
		expect(list[0].createdAt).toBeLessThanOrEqual(list[1].createdAt!);

		await connection.revertSnapshot!(NODE, vmId, first.id);
		await connection.deleteSnapshot!(NODE, vmId, second.id);
		await connection.deleteSnapshot!(NODE, vmId, first.id);
		expect(await connection.listSnapshots!(NODE, vmId)).toEqual([]);
	}, 10 * 60_000);

	it('shuts down a machine without a guest OS, or says why not', async () => {
		if ((await vm())?.state !== 'running') {
			await connection.power(NODE, vmId, 'start');
			await waitFor(async () => (await vm())?.state === 'running');
		}
		// Firmware only: there is no shutdown integration service to ask.
		const result = await connection.power(NODE, vmId, 'shutdown').then(
			() => 'ok',
			(error: Error) => error.message
		);
		logs.push(`info shutdown without a guest: ${result}`);
		await connection.power(NODE, vmId, 'stop');
		await waitFor(async () => (await vm())?.state === 'stopped');
	}, 5 * 60_000);

	it('marks a template, refuses to start it, and clears the mark', async () => {
		await connection.setTemplate!(NODE, vmId, true);
		expect(await vm()).toMatchObject({ template: true, description: 'created by the VM Manager end-to-end test' });
		await expect(connection.power(NODE, vmId, 'start')).rejects.toThrow(/template/);
		// Editing the notes right away keeps the marker (the provider reads the current notes first).
		await connection.updateVm(NODE, vmId, { ...(await config()), notes: 'edited while a template' });
		expect(await vm()).toMatchObject({ template: true, description: 'edited while a template' });
		await connection.setTemplate!(NODE, vmId, false);
		expect((await vm())?.template).toBeUndefined();
	}, 2 * 60_000);

	it('clones into a machine with its own disk, then deletes both with their disks', async () => {
		await connection.createSnapshot!(NODE, vmId, 'before-clone');
		expect(await connection.listSnapshots!(NODE, vmId)).toHaveLength(1);
		const copy = await connection.cloneVm!(NODE, vmId, cloneName);
		expect(copy).toMatchObject({ name: cloneName, state: 'stopped' });
		expect(copy.id).not.toBe(vmId);
		const copyDisk = (await connection.getVmDetails!(NODE, copy.id)).disks.find((d) => d.kind === 'disk')!;
		expect(copyDisk.path).toBeTruthy();
		expect(copyDisk.path).not.toBe(path.join(dir, `${name}.vhdx`));
		expect(fs.existsSync(copyDisk.path!)).toBe(true);
		expect(await connection.listSnapshots!(NODE, copy.id)).toEqual([]);
		expect((await vm(copy.id))?.template).toBeUndefined();

		const copyFolder = (await config(copy.id)).path as string;
		await connection.deleteVm(NODE, copy.id, { deleteDisks: true });
		expect(await vm(copy.id)).toBeUndefined();
		expect(fs.existsSync(copyDisk.path!)).toBe(false);
		// The clone's own folder under the VM storage path goes too.
		expect(fs.existsSync(copyFolder)).toBe(false);

		const disk = path.join(dir, `${name}.vhdx`);
		await connection.deleteVm(NODE, vmId, { deleteDisks: true });
		expect(await vm()).toBeUndefined();
		expect(fs.existsSync(disk)).toBe(false);
		// Checkpoint files (.avhdx) of the original must not be left behind either.
		expect(fs.readdirSync(dir).filter((f) => /\.a?vhdx$/i.test(f))).toEqual([]);
	}, 30 * 60_000);
});
