import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
	ProviderError,
	type Capabilities,
	type ChangeEvent,
	type ClusterConfig,
	type ClusterConnection,
	type ConsoleKind,
	type ConsoleStream,
	type DeleteOptions,
	type Disposable,
	type Event,
	type FieldSchema,
	type FieldValues,
	type HypervisorProvider,
	type Logger,
	type NodeInfo,
	type PowerAction,
	type ProviderContext,
	type VmConfig,
	type VmInfo,
	type VmState
} from '@vmm/sdk';
import { buildArgs, defaultAccelerators, type DiskBus, type Firmware, type NicModel, type VgaModel, type VmDefinition, type VmRuntime } from './definition';
import { detectQemu, type QemuInstallation } from './detect';
import { GuestAgentClient } from './GuestAgent';
import { QmpClient, type QmpEvent } from './QmpClient';
import { gracefulShutdown } from './shutdown';

const execFileAsync = promisify(execFile);
const NODE_ID = 'local';
const VM_NAME = /^[\w .()-]{1,64}$/;

const CONNECTION_SCHEMA: FieldSchema[] = [
	{
		key: 'qemuPath',
		label: 'QEMU directory',
		type: 'directory',
		description: 'Directory with qemu-system-x86_64 and qemu-img. Leave empty to detect automatically.',
		placeholder: 'Detect automatically'
	},
	{
		key: 'vmDirectory',
		label: 'VM storage directory',
		type: 'directory',
		description: 'Where VM definitions and disks are stored. Leave empty for the extension storage.',
		placeholder: 'Extension storage'
	},
	{
		key: 'shutdownTimeout',
		label: 'Shutdown timeout',
		type: 'number',
		unit: 's',
		min: 5,
		max: 600,
		default: 30,
		description: 'How long to wait for the guest after a shutdown request before offering to power it off.'
	},
	{
		key: 'accelerator',
		label: 'Acceleration',
		type: 'select',
		default: 'auto',
		required: true,
		options: [
			{ value: 'auto', label: 'Automatic', description: 'WHPX on Windows, KVM on Linux, HVF on macOS — falls back to TCG' },
			{ value: 'whpx', label: 'WHPX', description: 'Windows Hypervisor Platform' },
			{ value: 'kvm', label: 'KVM', description: 'Linux' },
			{ value: 'hvf', label: 'HVF', description: 'macOS Hypervisor.framework' },
			{ value: 'tcg', label: 'TCG', description: 'Software emulation (slow)' }
		]
	}
];

const NIC_OPTIONS = [
	{ value: 'e1000', label: 'Intel e1000', description: 'Works with almost every guest' },
	{ value: 'virtio-net-pci', label: 'VirtIO', description: 'Fastest; needs VirtIO drivers on Windows guests' },
	{ value: 'rtl8139', label: 'Realtek RTL8139' },
	{ value: 'none', label: 'No network' }
];

const DISK_BUS_OPTIONS = [
	{ value: 'sata', label: 'SATA', description: 'Works with almost every guest' },
	{ value: 'virtio', label: 'VirtIO', description: 'Fastest; needs VirtIO drivers on Windows guests' }
];

const VGA_OPTIONS = [
	{ value: 'std', label: 'Standard VGA' },
	{ value: 'virtio', label: 'VirtIO GPU' },
	{ value: 'qxl', label: 'QXL' },
	{ value: 'cirrus', label: 'Cirrus (legacy)' }
];

const FIRMWARE_OPTIONS = [
	{ value: 'uefi', label: 'UEFI', description: 'Modern operating systems' },
	{ value: 'bios', label: 'BIOS', description: 'Legacy operating systems' }
];

export interface QemuProviderOptions {
	/** Default QEMU directory from the user settings. */
	defaultQemuPath: () => string | undefined;
}

export class QemuProvider implements HypervisorProvider {
	readonly id = 'qemu';
	readonly displayName = 'QEMU';
	readonly icon = 'vm';
	readonly connectionSchema = CONNECTION_SCHEMA;

	constructor(private readonly options: QemuProviderOptions) {}

	defaultClusterName(): string {
		return 'Local (QEMU)';
	}

	async testConnection(cluster: ClusterConfig): Promise<void> {
		await detectQemu(this.qemuPath(cluster));
	}

	async connect(cluster: ClusterConfig, _secrets: unknown, context: ProviderContext): Promise<ClusterConnection> {
		const installation = await detectQemu(this.qemuPath(cluster));
		context.log.info(`Using QEMU ${installation.version} from ${installation.directory}`);
		const vmDirectory = (cluster.config.vmDirectory as string | undefined) || path.join(context.storagePath, 'vms');
		await fs.promises.mkdir(vmDirectory, { recursive: true });
		const timeout = Number(cluster.config.shutdownTimeout);
		const shutdownTimeoutMs = (Number.isFinite(timeout) && timeout >= 5 ? Math.min(timeout, 600) : 30) * 1000;
		return new QemuConnection(installation, vmDirectory, String(cluster.config.accelerator ?? 'auto'), context.log, shutdownTimeoutMs);
	}

	private qemuPath(cluster: ClusterConfig): string | undefined {
		return (cluster.config.qemuPath as string | undefined) || this.options.defaultQemuPath() || undefined;
	}
}

class SimpleEmitter<T> {
	private readonly emitter = new EventEmitter();
	readonly event: Event<T> = (listener) => {
		this.emitter.on('e', listener);
		return { dispose: () => this.emitter.off('e', listener) } satisfies Disposable;
	};
	fire(value: T): void {
		this.emitter.emit('e', value);
	}
	dispose(): void {
		this.emitter.removeAllListeners();
	}
}

export class QemuConnection implements ClusterConnection {
	readonly capabilities: Capabilities = {
		create: true,
		edit: true,
		delete: true,
		power: ['start', 'shutdown', 'reboot', 'stop'],
		consoles: ['vnc', 'serial'],
		preview: false,
		external: false
	};
	private readonly changes = new SimpleEmitter<ChangeEvent>();
	readonly onDidChange = this.changes.event;
	private readonly qmp = new Map<string, Promise<QmpClient>>();

	constructor(
		private readonly qemu: QemuInstallation,
		private readonly vmDirectory: string,
		private readonly accelerator: string,
		private readonly log: Logger,
		private readonly shutdownTimeoutMs = 30_000
	) {}

	// -----------------------------------------------------------------------------------------
	// Storage
	// -----------------------------------------------------------------------------------------

	private dir(id: string): string {
		if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProviderError('Invalid virtual machine id', 'invalid');
		return path.join(this.vmDirectory, id);
	}

	private async definitions(): Promise<VmDefinition[]> {
		const entries = await fs.promises.readdir(this.vmDirectory, { withFileTypes: true }).catch(() => []);
		const result: VmDefinition[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			try {
				const raw = await fs.promises.readFile(path.join(this.vmDirectory, entry.name, 'vm.json'), 'utf8');
				result.push(JSON.parse(raw) as VmDefinition);
			} catch {
				// not a VM directory
			}
		}
		return result;
	}

	private async definition(id: string): Promise<VmDefinition> {
		try {
			return JSON.parse(await fs.promises.readFile(path.join(this.dir(id), 'vm.json'), 'utf8')) as VmDefinition;
		} catch {
			throw new ProviderError('Virtual machine not found', 'notFound');
		}
	}

	private async saveDefinition(def: VmDefinition): Promise<void> {
		await fs.promises.writeFile(path.join(this.dir(def.id), 'vm.json'), JSON.stringify(def, null, 2));
	}

	private async runtime(id: string): Promise<VmRuntime | undefined> {
		try {
			const runtime = JSON.parse(await fs.promises.readFile(path.join(this.dir(id), 'runtime.json'), 'utf8')) as VmRuntime;
			if (isAlive(runtime.pid)) return runtime;
		} catch {
			return undefined;
		}
		await this.clearRuntime(id);
		return undefined;
	}

	private async clearRuntime(id: string): Promise<void> {
		this.closeQmp(id);
		await fs.promises.rm(path.join(this.dir(id), 'runtime.json'), { force: true });
	}

	// -----------------------------------------------------------------------------------------
	// QMP
	// -----------------------------------------------------------------------------------------

	private client(id: string, runtime: VmRuntime): Promise<QmpClient> {
		const existing = this.qmp.get(id);
		if (existing) return existing;
		const promise = QmpClient.connect(runtime.qmpPort).then((client) => {
			client.on('event', (event: QmpEvent) => {
				this.log.debug(`QMP ${id}: ${event.event}`);
				this.changes.fire({ nodeId: NODE_ID, vmId: id });
			});
			client.on('close', () => {
				if (this.qmp.get(id) === promise) this.qmp.delete(id);
				this.changes.fire({ nodeId: NODE_ID, vmId: id });
			});
			return client;
		});
		promise.catch(() => {
			if (this.qmp.get(id) === promise) this.qmp.delete(id);
		});
		this.qmp.set(id, promise);
		return promise;
	}

	private closeQmp(id: string): void {
		const existing = this.qmp.get(id);
		this.qmp.delete(id);
		void existing?.then((c) => c.close()).catch(() => undefined);
	}

	private async state(def: VmDefinition, runtime: VmRuntime | undefined): Promise<VmState> {
		if (!runtime) return 'stopped';
		try {
			const client = await this.client(def.id, runtime);
			const status = await client.execute<{ status: string; running: boolean }>('query-status');
			if (status.running) return 'running';
			if (status.status === 'paused' || status.status === 'suspended') return 'paused';
			if (status.status === 'shutdown') return 'stopping';
			return 'starting';
		} catch {
			return Date.now() - runtime.startedAt < 30_000 ? 'starting' : 'unknown';
		}
	}

	// -----------------------------------------------------------------------------------------
	// ClusterConnection
	// -----------------------------------------------------------------------------------------

	async listNodes(): Promise<NodeInfo[]> {
		const total = Math.round(os.totalmem() / 1024 / 1024);
		return [
			{
				id: NODE_ID,
				name: os.hostname(),
				status: 'online',
				cpus: os.cpus().length,
				memoryMB: total,
				memoryUsedMB: total - Math.round(os.freemem() / 1024 / 1024),
				description: `QEMU ${this.qemu.version}`
			}
		];
	}

	async listVms(): Promise<VmInfo[]> {
		const defs = await this.definitions();
		return Promise.all(
			defs.map(async (def) => {
				const runtime = await this.runtime(def.id);
				const state = await this.state(def, runtime);
				const consoles: ConsoleKind[] = def.serial ? ['vnc', 'serial'] : ['vnc'];
				return {
					id: def.id,
					name: def.name,
					state,
					cpus: def.cpus,
					memoryMB: def.memoryMB,
					uptimeSeconds: runtime ? Math.floor((Date.now() - runtime.startedAt) / 1000) : undefined,
					description: def.notes,
					os: `${def.firmware.toUpperCase()} · ${def.diskBus.toUpperCase()}`,
					consoles
				} satisfies VmInfo;
			})
		);
	}

	async getCreateSchema(): Promise<FieldSchema[]> {
		return [
			{ key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'my-vm', description: 'Letters, digits, spaces and . _ ( ) -' },
			{ key: 'cpus', label: 'Processors', type: 'number', unit: 'cores', min: 1, max: os.cpus().length, default: Math.min(2, os.cpus().length), required: true },
			{ key: 'memoryMB', label: 'Memory', type: 'number', unit: 'MB', min: 128, default: 2048, required: true },
			{ key: 'diskGB', label: 'Disk size', type: 'number', unit: 'GB', min: 1, max: 16384, default: 32, required: true },
			{ key: 'cdrom', label: 'Installation media (ISO)', type: 'file', filters: { 'Disk images': ['iso', 'img'] } },
			{
				key: 'firmware',
				label: 'Firmware',
				type: 'select',
				required: true,
				default: this.qemu.firmwareCode ? 'uefi' : 'bios',
				options: this.qemu.firmwareCode ? FIRMWARE_OPTIONS : FIRMWARE_OPTIONS.filter((o) => o.value === 'bios')
			},
			{ key: 'diskBus', label: 'Disk controller', type: 'select', required: true, default: 'sata', options: DISK_BUS_OPTIONS, advanced: true },
			{ key: 'nic', label: 'Network adapter', type: 'select', required: true, default: 'e1000', options: NIC_OPTIONS, advanced: true },
			{ key: 'vga', label: 'Display adapter', type: 'select', required: true, default: 'std', options: VGA_OPTIONS, advanced: true },
			{ key: 'serial', label: 'Serial console', type: 'checkbox', default: true, advanced: true },
			{ key: 'notes', label: 'Notes', type: 'textarea', advanced: true }
		];
	}

	async createVm(_nodeId: string, values: FieldValues): Promise<VmInfo> {
		const name = String(values.name ?? '').trim();
		if (!VM_NAME.test(name)) throw new ProviderError('Use 1–64 letters, digits, spaces or . _ ( ) - for the name', 'invalid');
		if ((await this.definitions()).some((d) => d.name.toLowerCase() === name.toLowerCase())) {
			throw new ProviderError(`A virtual machine named "${name}" already exists`, 'invalid');
		}
		const id = randomUUID();
		const dir = this.dir(id);
		await fs.promises.mkdir(dir, { recursive: true });
		try {
			const disk = path.join(dir, 'disk0.qcow2');
			const sizeGB = Math.max(1, Math.round(Number(values.diskGB ?? 32)));
			await execFileAsync(this.qemu.img, ['create', '-f', 'qcow2', disk, `${sizeGB}G`], { windowsHide: true, timeout: 60_000 });
			const def: VmDefinition = {
				id,
				name,
				cpus: Number(values.cpus ?? 2),
				memoryMB: Number(values.memoryMB ?? 2048),
				cpuModel: 'max',
				firmware: (values.firmware as Firmware) ?? 'bios',
				disks: [disk],
				diskBus: (values.diskBus as DiskBus) ?? 'sata',
				cdrom: (values.cdrom as string | undefined) || undefined,
				nic: (values.nic as NicModel) ?? 'e1000',
				vga: (values.vga as VgaModel) ?? 'std',
				serial: values.serial !== false,
				notes: (values.notes as string | undefined) || undefined,
				createdAt: Date.now()
			};
			if (def.firmware === 'uefi') await this.ensureVars(def);
			await this.saveDefinition(def);
			this.log.info(`Created ${name} in ${dir}`);
			return { id, name, state: 'stopped', cpus: def.cpus, memoryMB: def.memoryMB };
		} catch (error) {
			await fs.promises.rm(dir, { recursive: true, force: true });
			throw error;
		}
	}

	private async ensureVars(def: VmDefinition): Promise<string | undefined> {
		const vars = path.join(this.dir(def.id), 'efivars.fd');
		if (fs.existsSync(vars)) return vars;
		if (!this.qemu.firmwareVarsTemplate) return undefined;
		await fs.promises.copyFile(this.qemu.firmwareVarsTemplate, vars);
		return vars;
	}

	async getVmConfig(_nodeId: string, vmId: string): Promise<VmConfig> {
		const def = await this.definition(vmId);
		const running = !!(await this.runtime(vmId));
		const restart = running ? 'Applies after the next start.' : undefined;
		const schema: FieldSchema[] = [
			{ key: 'name', label: 'Name', type: 'text', required: true, group: 'General' },
			{ key: 'notes', label: 'Notes', type: 'textarea', group: 'General' },
			{ key: 'location', label: 'Location', type: 'text', readonly: true, group: 'General' },
			{ key: 'cpus', label: 'Processors', type: 'number', unit: 'cores', min: 1, max: os.cpus().length, required: true, group: 'Hardware', description: restart },
			{ key: 'memoryMB', label: 'Memory', type: 'number', unit: 'MB', min: 128, required: true, group: 'Hardware', description: restart },
			{ key: 'cpuModel', label: 'CPU model', type: 'text', required: true, group: 'Hardware', description: 'QEMU -cpu value, e.g. max, host, qemu64' },
			{ key: 'disks', label: 'Disks', type: 'text', readonly: true, group: 'Storage' },
			{ key: 'diskBus', label: 'Disk controller', type: 'select', required: true, options: DISK_BUS_OPTIONS, group: 'Storage', description: restart },
			{ key: 'cdrom', label: 'CD/DVD (ISO)', type: 'file', filters: { 'Disk images': ['iso', 'img'] }, group: 'Storage', description: restart },
			{ key: 'nic', label: 'Network adapter', type: 'select', required: true, options: NIC_OPTIONS, group: 'Network', description: restart },
			{ key: 'vga', label: 'Display adapter', type: 'select', required: true, options: VGA_OPTIONS, group: 'Display', description: restart },
			{ key: 'serial', label: 'Serial console', type: 'checkbox', group: 'Display', description: restart },
			{
				key: 'firmware',
				label: 'Firmware',
				type: 'select',
				required: true,
				options: this.qemu.firmwareCode ? FIRMWARE_OPTIONS : FIRMWARE_OPTIONS.filter((o) => o.value === 'bios' || o.value === def.firmware),
				group: 'Advanced',
				description: restart
			},
			{ key: 'extraArgs', label: 'Extra QEMU arguments', type: 'text', group: 'Advanced', description: 'Appended to the command line, e.g. -device virtio-rng-pci' }
		];
		return {
			schema,
			values: {
				name: def.name,
				notes: def.notes,
				location: this.dir(def.id),
				cpus: def.cpus,
				memoryMB: def.memoryMB,
				cpuModel: def.cpuModel,
				disks: def.disks.join('; '),
				diskBus: def.diskBus,
				cdrom: def.cdrom,
				nic: def.nic,
				vga: def.vga,
				serial: def.serial,
				firmware: def.firmware,
				extraArgs: def.extraArgs
			}
		};
	}

	async updateVm(_nodeId: string, vmId: string, values: FieldValues): Promise<void> {
		const def = await this.definition(vmId);
		if (values.name !== undefined) {
			const name = String(values.name).trim();
			if (!VM_NAME.test(name)) throw new ProviderError('Use 1–64 letters, digits, spaces or . _ ( ) - for the name', 'invalid');
			const clash = (await this.definitions()).some((d) => d.id !== def.id && d.name.toLowerCase() === name.toLowerCase());
			if (clash) throw new ProviderError(`A virtual machine named "${name}" already exists`, 'invalid');
			def.name = name;
		}
		if (values.cpus !== undefined) def.cpus = Number(values.cpus);
		if (values.memoryMB !== undefined) def.memoryMB = Number(values.memoryMB);
		if (values.cpuModel !== undefined) def.cpuModel = String(values.cpuModel);
		if (values.diskBus !== undefined) def.diskBus = values.diskBus as DiskBus;
		if (values.nic !== undefined) def.nic = values.nic as NicModel;
		if (values.vga !== undefined) def.vga = values.vga as VgaModel;
		if (values.serial !== undefined) def.serial = Boolean(values.serial);
		if (values.firmware !== undefined) def.firmware = values.firmware as Firmware;
		def.cdrom = (values.cdrom as string | undefined) || undefined;
		def.notes = (values.notes as string | undefined) || undefined;
		def.extraArgs = (values.extraArgs as string | undefined) || undefined;
		if (def.firmware === 'uefi') await this.ensureVars(def);
		await this.saveDefinition(def);
		// Hot-swap the ISO of a running VM.
		const runtime = await this.runtime(vmId);
		if (runtime) {
			try {
				const client = await this.client(vmId, runtime);
				if (def.cdrom) await client.execute('blockdev-change-medium', { id: 'cd0', filename: def.cdrom, format: 'raw' });
				else await client.execute('eject', { id: 'cd0', force: true });
			} catch (error) {
				this.log.debug(`Changing the CD of ${def.name} at runtime failed: ${(error as Error).message}`);
			}
		}
	}

	async deleteVm(_nodeId: string, vmId: string, options: DeleteOptions): Promise<void> {
		const def = await this.definition(vmId);
		if (await this.runtime(vmId)) await this.forceStop(vmId);
		const dir = this.dir(vmId);
		if (options.deleteDisks) {
			await fs.promises.rm(dir, { recursive: true, force: true });
		} else {
			for (const file of ['vm.json', 'runtime.json', 'efivars.fd', 'qemu.log']) {
				await fs.promises.rm(path.join(dir, file), { force: true });
			}
		}
		this.log.info(`Deleted ${def.name}${options.deleteDisks ? ' including disks' : ''}`);
	}

	async power(_nodeId: string, vmId: string, action: PowerAction): Promise<void> {
		const def = await this.definition(vmId);
		const runtime = await this.runtime(vmId);
		if (action === 'start') {
			if (runtime) {
				const client = await this.client(vmId, runtime);
				await client.execute('cont');
				return;
			}
			await this.start(def);
			return;
		}
		if (!runtime) throw new ProviderError(`${def.name} is not running`, 'unavailable');
		if (action === 'stop') {
			await this.forceStop(vmId);
			return;
		}
		const client = await this.client(vmId, runtime);
		if (action === 'shutdown') {
			const method = await gracefulShutdown(
				{
					agent: () => this.agentRequest(runtime, 'powerdown'),
					acpi: async () => {
						// A paused guest cannot react to the power button.
						await client.execute('cont').catch(() => undefined);
						await client.execute('system_powerdown');
					},
					waitStopped: (ms) => this.waitStopped(runtime.pid, ms)
				},
				this.shutdownTimeoutMs,
				def.name
			);
			this.log.info(`${def.name} shut down via ${method === 'agent' ? 'the guest agent' : 'ACPI'}`);
			await this.clearRuntime(vmId);
			this.changes.fire({ nodeId: NODE_ID, vmId });
		} else if (action === 'reboot') {
			// Soft reboot through the agent when it answers; otherwise a hardware reset.
			if (!(await this.agentRequest(runtime, 'reboot'))) await client.execute('system_reset');
		} else {
			await client.execute('system_reset');
		}
	}

	/** Asks the guest agent for a clean shutdown/reboot. `false` when the VM has no answering agent. */
	private async agentRequest(runtime: VmRuntime, mode: 'powerdown' | 'reboot'): Promise<boolean> {
		if (!runtime.agentPort) return false;
		try {
			const agent = await GuestAgentClient.connect(runtime.agentPort, 2000);
			try {
				await agent.shutdown(mode);
			} finally {
				agent.close();
			}
			return true;
		} catch {
			return false;
		}
	}

	/** Resolves `true` once the QEMU process is gone, `false` after `timeoutMs`. */
	private async waitStopped(pid: number, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!isAlive(pid)) return true;
			await sleep(200);
		}
		return !isAlive(pid);
	}

	private async start(def: VmDefinition): Promise<void> {
		const dir = this.dir(def.id);
		for (const disk of def.disks) {
			if (!fs.existsSync(disk)) throw new ProviderError(`Disk not found: ${disk}`, 'invalid');
		}
		if (def.cdrom && !fs.existsSync(def.cdrom)) throw new ProviderError(`ISO not found: ${def.cdrom}`, 'invalid');
		const runtime: VmRuntime = {
			pid: 0,
			qmpPort: await freePort(),
			vncPort: await freePort(5900, 5999),
			serialPort: def.serial ? await freePort() : undefined,
			agentPort: await freePort(),
			startedAt: Date.now()
		};
		const args = buildArgs(def, runtime, {
			accelerators: defaultAccelerators(process.platform, this.accelerator),
			firmwareCode: this.qemu.firmwareCode,
			firmwareVars: def.firmware === 'uefi' ? await this.ensureVars(def) : undefined
		});
		const logPath = path.join(dir, 'qemu.log');
		const logFd = fs.openSync(logPath, 'w');
		this.log.info(`Starting ${def.name}: ${this.qemu.system} ${args.join(' ')}`);
		const child = spawn(this.qemu.system, args, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, cwd: dir });
		fs.closeSync(logFd);
		if (!child.pid) throw new ProviderError('QEMU could not be started');
		let exited = false;
		child.once('exit', () => (exited = true));
		child.unref();
		runtime.pid = child.pid;
		await fs.promises.writeFile(path.join(dir, 'runtime.json'), JSON.stringify(runtime, null, 2));

		// Wait for QMP; report QEMU's own error output when it dies early.
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (exited || !isAlive(runtime.pid)) {
				await this.clearRuntime(def.id);
				const output = (await fs.promises.readFile(logPath, 'utf8').catch(() => '')).trim();
				throw new ProviderError(`QEMU exited: ${output.split('\n').slice(-5).join(' ') || 'no output'}`, 'failed');
			}
			try {
				await this.client(def.id, runtime);
				this.changes.fire({ nodeId: NODE_ID, vmId: def.id });
				return;
			} catch {
				await sleep(250);
			}
		}
		throw new ProviderError('QEMU started but its control socket did not respond', 'failed');
	}

	private async forceStop(vmId: string): Promise<void> {
		const runtime = await this.runtime(vmId);
		if (!runtime) return;
		try {
			const client = await this.client(vmId, runtime);
			await client.execute('quit').catch(() => undefined);
		} catch {
			// QMP unreachable: kill the process below.
		}
		if (!(await this.waitStopped(runtime.pid, 5000))) {
			// QMP did not honour `quit` (hung or unreachable): terminate, then kill.
			signal(runtime.pid, 'SIGTERM');
			if (!(await this.waitStopped(runtime.pid, 3000))) {
				signal(runtime.pid, 'SIGKILL');
				await this.waitStopped(runtime.pid, 2000);
			}
		}
		await this.clearRuntime(vmId);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	async openConsole(_nodeId: string, vmId: string, kind: ConsoleKind): Promise<ConsoleStream> {
		const def = await this.definition(vmId);
		const runtime = await this.runtime(vmId);
		if (!runtime) throw new ProviderError(`${def.name} is not running`, 'unavailable');
		const port = kind === 'vnc' ? runtime.vncPort : runtime.serialPort;
		if (!port) throw new ProviderError('The serial console is disabled for this VM. Enable it in the settings and restart the VM.', 'unavailable');
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.connect({ port, host: '127.0.0.1' });
			s.once('connect', () => resolve(s));
			s.once('error', reject);
		});
		socket.setNoDelay(true);
		return { stream: socket, dispose: () => socket.destroy() };
	}

	dispose(): void {
		for (const id of [...this.qmp.keys()]) this.closeQmp(id);
		this.changes.dispose();
	}
}

function isAlive(pid: number): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch {
		// already gone
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryListen(port: number): Promise<number | undefined> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.unref();
		server.once('error', () => resolve(undefined));
		server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
			const address = server.address();
			const actual = typeof address === 'object' && address ? address.port : undefined;
			server.close(() => resolve(actual));
		});
	});
}

/** A free localhost port; within [min, max] when given (VNC needs 5900 + display). */
export async function freePort(min?: number, max?: number): Promise<number> {
	if (min === undefined) {
		const port = await tryListen(0);
		if (!port) throw new ProviderError('No free TCP port available');
		return port;
	}
	for (let port = min; port <= (max ?? min); port++) {
		if (await tryListen(port)) return port;
	}
	throw new ProviderError(`No free TCP port between ${min} and ${max}`);
}
