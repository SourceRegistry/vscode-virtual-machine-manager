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
	type DiskStats,
	type Disposable,
	type Event,
	type ExternalVmInfo,
	type FieldSchema,
	type FieldValues,
	type HypervisorProvider,
	type ImportCandidate,
	type ImportOptions,
	type Logger,
	type NodeInfo,
	type PortForward,
	type PowerAction,
	type ProviderContext,
	type VmConfig,
	type VmDetails,
	type VmInfo,
	type VmState,
	type VmStats
} from '@vmm/sdk';
import { buildArgs, defaultAccelerators, usableAccelerators, type DiskBus, type Firmware, type NicModel, type VgaModel, type VmDefinition, type VmRuntime } from './definition';
import { detectQemu, type QemuInstallation } from './detect';
import { GuestAgentClient } from './GuestAgent';
import { QmpClient, type QmpEvent } from './QmpClient';
import { availableMemoryMB, CpuLoadSampler } from './hostInfo';
import { listProcesses, processStartedAt, sampleProcess, walkFiles } from './hostProcess';
import { candidatesFromFolder, classifyFile, type FolderCandidate, type FolderInput } from './importers';
import { findExternalVms, type ExternalVm } from './scan';
import {
	hasMedia,
	nextCpuSample,
	type CpuSample,
	nicDevice,
	parseBlockDevices,
	parseBlockStats,
	parsePciDevices,
	removableQdev,
	type GuestInterface,
	type QmpBlock,
	type QmpBlockStats,
	type QmpPciBus
} from './inspect';
import { addCommand, hmpError, normalizeForward, removeCommand, sameHostSocket, validateForward } from './forwards';
import { isPortConflict, SerialQueue } from './ports';
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
		external: false,
		media: true,
		details: true,
		forwards: true,
		adopt: true,
		importFolder: true,
		stats: true
	};
	private readonly hostCpu = new CpuLoadSampler();
	private readonly startQueue = new SerialQueue();
	private readonly cpuSamples = new Map<string, CpuSample>();
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
		const target = runtime.qmpSocket ? QmpClient.connectSocket(runtime.qmpSocket) : runtime.qmpPort ? QmpClient.connect(runtime.qmpPort, runtime.qmpHost) : undefined;
		if (!target) {
			return Promise.reject(new ProviderError('This VM was started outside VM Manager without a control socket, so it can only be observed and powered off. Restart it from here to manage it fully.', 'unsupported'));
		}
		const promise = target.then((client) => {
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
		if (!hasControlChannel(runtime)) return 'running';
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
		const available = await availableMemoryMB();
		const accelerators = usableAccelerators(defaultAccelerators(process.platform, this.accelerator), this.qemu.accelerators);
		const active = accelerators[0]?.split(',')[0] ?? 'tcg';
		return [
			{
				id: NODE_ID,
				name: os.hostname(),
				status: 'online',
				cpus: os.cpus().length,
				cpuUsage: this.hostCpu.sample(),
				memoryMB: total,
				memoryUsedMB: Math.max(0, total - available),
				description: `QEMU ${this.qemu.version}`,
				facts: [
					{ label: 'QEMU', value: this.qemu.version },
					{ label: 'Acceleration', value: active === 'tcg' ? 'Software emulation (TCG)' : active.toUpperCase() },
					{ label: 'Platform', value: `${os.platform()} ${os.arch()}` }
				]
			}
		];
	}

	async listVms(): Promise<VmInfo[]> {
		const defs = await this.definitions();
		const visible: VmDefinition[] = [];
		for (const def of defs) {
			// An adopted VM only exists while its process does; nothing here could restart it faithfully.
			if (def.origin === 'adopted' && !(await this.runtime(def.id))) {
				await fs.promises.rm(this.dir(def.id), { recursive: true, force: true });
				continue;
			}
			visible.push(def);
		}
		return Promise.all(
			visible.map(async (def) => {
				const runtime = await this.runtime(def.id);
				const state = await this.state(def, runtime);
				const consoles: ConsoleKind[] = [];
				if (!runtime || runtime.vncPort) consoles.push('vnc');
				if (def.serial) consoles.push('serial');
				let mediaInserted = !!def.cdrom;
				if (runtime && state !== 'stopped' && hasControlChannel(runtime)) {
					try {
						mediaInserted = hasMedia(await (await this.client(def.id, runtime)).execute<QmpBlock[]>('query-block'));
					} catch {
						// keep the definition's answer
					}
				}
				return {
					id: def.id,
					name: def.name,
					state,
					cpus: def.cpus,
					memoryMB: def.memoryMB,
					uptimeSeconds: runtime ? Math.floor((Date.now() - runtime.startedAt) / 1000) : undefined,
					description: def.notes,
					os: `${def.firmware.toUpperCase()} · ${def.diskBus.toUpperCase()}`,
					consoles,
					mediaInserted,
					origin: def.origin,
					controllable: runtime ? hasControlChannel(runtime) : undefined
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
				mac: randomMac(),
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
			{ key: 'cdrom', label: 'CD/DVD (ISO)', type: 'file', filters: { 'Disk images': ['iso', 'img'] }, mediaDevice: 'cd0', group: 'Storage' },
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
				await this.swapMedia(vmId, runtime, 'cd0', def.cdrom);
			} catch (error) {
				this.log.warn(`Changing the CD of ${def.name} at runtime failed: ${(error as Error).message}`);
			}
		}
	}

	// -----------------------------------------------------------------------------------------
	// Hardware inventory, statistics, media
	// -----------------------------------------------------------------------------------------

	async getVmDetails(_nodeId: string, vmId: string): Promise<VmDetails> {
		const def = await this.definition(vmId);
		const runtime = await this.runtime(vmId);
		const context = { diskBus: def.diskBus };
		let blocks: QmpBlock[] | undefined;
		let pci: QmpPciBus[] = [];
		if (runtime) {
			try {
				const client = await this.client(vmId, runtime);
				blocks = await client.execute<QmpBlock[]>('query-block');
				pci = await client.execute<QmpPciBus[]>('query-pci').catch(() => []);
			} catch (error) {
				this.log.debug(`Inspecting ${def.name} failed: ${(error as Error).message}`);
			}
		}
		const disks = blocks ? parseBlockDevices(blocks, context) : await this.offlineDisks(def, context.diskBus);
		let interfaces: GuestInterface[] | undefined;
		if (runtime?.agentPort) {
			interfaces = await this.guestInterfaces(runtime.agentPort);
		}
		return {
			disks,
			nics: nicDevice(def.nic, def.mac, interfaces, !!runtime),
			devices: parsePciDevices(pci),
			forwards: def.forwards ?? []
		};
	}

	private async offlineDisks(def: VmDefinition, bus: string): Promise<VmDetails['disks']> {
		const disks = await Promise.all(
			def.disks.map(async (file, index) => {
				const info = await this.imageInfo(file);
				return {
					id: `disk${index}`,
					kind: 'disk' as const,
					label: `Hard disk ${index + 1}`,
					path: file,
					sizeBytes: info?.['virtual-size'],
					format: info?.format,
					bus
				};
			})
		);
		const cd = def.cdrom ? await this.imageInfo(def.cdrom) : undefined;
		return [
			...disks,
			{ id: 'cd0', kind: 'cdrom' as const, label: 'CD/DVD drive', path: def.cdrom, sizeBytes: cd?.['virtual-size'], format: cd?.format, bus: 'sata', readOnly: true, removable: true }
		];
	}

	private async imageInfo(file: string): Promise<{ 'virtual-size'?: number; format?: string } | undefined> {
		try {
			const { stdout } = await execFileAsync(this.qemu.img, ['info', '--output=json', file], { windowsHide: true, timeout: 10_000 });
			return JSON.parse(stdout) as { 'virtual-size'?: number; format?: string };
		} catch {
			return undefined;
		}
	}

	private async guestInterfaces(port: number): Promise<GuestInterface[] | undefined> {
		try {
			const agent = await GuestAgentClient.connect(port, 1000);
			try {
				return await agent.execute<GuestInterface[]>('guest-network-get-interfaces');
			} finally {
				agent.close();
			}
		} catch {
			return undefined;
		}
	}

	async getVmStats(_nodeId: string, vmId: string): Promise<VmStats> {
		const def = await this.definition(vmId);
		const runtime = await this.runtime(vmId);
		const at = Date.now();
		if (!runtime) {
			this.cpuSamples.delete(vmId);
			return { timestamp: at, memoryMB: def.memoryMB };
		}
		const [process_, disks] = await Promise.all([
			sampleProcess(runtime.pid),
			this.client(vmId, runtime)
				.then((c) => c.execute<QmpBlockStats[]>('query-blockstats'))
				.then((list) => parseBlockStats(list))
				.catch((): DiskStats[] | undefined => undefined)
		]);
		let cpuUsage: number | undefined;
		if (process_) {
			const next = nextCpuSample(this.cpuSamples.get(vmId), { at, cpuSeconds: process_.cpuSeconds }, def.cpus);
			cpuUsage = next.usage;
			this.cpuSamples.set(vmId, next.sample);
		}
		return { timestamp: at, cpuUsage, memoryUsedMB: process_?.rssMB, memoryMB: def.memoryMB, disks };
	}

	async ejectMedia(_nodeId: string, vmId: string, deviceId: string): Promise<void> {
		await this.changeMedia(vmId, deviceId, undefined);
	}

	async insertMedia(_nodeId: string, vmId: string, deviceId: string, imagePath: string): Promise<void> {
		if (!fs.existsSync(imagePath)) throw new ProviderError(`Image not found: ${imagePath}`, 'invalid');
		await this.changeMedia(vmId, deviceId, imagePath);
	}

	async addPortForward(_nodeId: string, vmId: string, forward: PortForward): Promise<void> {
		const invalid = validateForward(forward);
		if (invalid) throw new ProviderError(invalid, 'invalid');
		const def = await this.definition(vmId);
		if (def.nic === 'none') throw new ProviderError('The VM has no network adapter', 'invalid');
		const rule = normalizeForward(forward);
		if ((def.forwards ?? []).some((f) => sameHostSocket(f, rule))) {
			throw new ProviderError(`Host port ${rule.hostPort}/${rule.protocol} is already forwarded`, 'invalid');
		}
		const runtime = await this.runtime(vmId);
		if (runtime) await this.monitor(vmId, runtime, addCommand(rule), `Could not forward port ${rule.hostPort}`);
		def.forwards = [...(def.forwards ?? []), rule];
		await this.saveDefinition(def);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	async removePortForward(_nodeId: string, vmId: string, forward: PortForward): Promise<void> {
		const def = await this.definition(vmId);
		const rule = normalizeForward(forward);
		const runtime = await this.runtime(vmId);
		if (runtime) {
			// Already gone in the running VM (e.g. the definition was edited): still drop it from the definition.
			await this.monitor(vmId, runtime, removeCommand(rule), `Could not remove forward ${rule.hostPort}`).catch((error: Error) =>
				this.log.warn(error.message)
			);
		}
		def.forwards = (def.forwards ?? []).filter((f) => !sameHostSocket(f, rule));
		await this.saveDefinition(def);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	/** Runs a human-monitor command through QMP; HMP prints errors as text. */
	private async monitor(vmId: string, runtime: VmRuntime, commandLine: string, failure: string): Promise<void> {
		const client = await this.client(vmId, runtime);
		const output = await client.execute<string>('human-monitor-command', { 'command-line': commandLine });
		const error = hmpError(output);
		if (error) throw new ProviderError(`${failure}: ${error}`, 'failed');
	}

	/** Swaps the medium of the VM's CD/DVD drive and remembers it, so the next start matches. */
	private async changeMedia(vmId: string, deviceId: string, image: string | undefined): Promise<void> {
		const def = await this.definition(vmId);
		if (deviceId !== 'cd0') throw new ProviderError(`${deviceId} is not a CD/DVD drive`, 'invalid');
		const runtime = await this.runtime(vmId);
		if (runtime) await this.swapMedia(vmId, runtime, deviceId, image);
		def.cdrom = image;
		await this.saveDefinition(def);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	private async swapMedia(vmId: string, runtime: VmRuntime, deviceId: string, image: string | undefined): Promise<void> {
		const client = await this.client(vmId, runtime);
		// `id` is the QOM path of the drive's device; the block device name is not accepted by QEMU 11.
		const qdev = removableQdev(await client.execute<QmpBlock[]>('query-block'), deviceId);
		if (!qdev) throw new ProviderError('The virtual machine has no CD/DVD drive', 'unavailable');
		// Eject first (forced, so a tray the guest locked doesn't block it); harmless on an empty drive.
		await client.execute('eject', { id: qdev, force: true });
		if (image) await client.execute('blockdev-change-medium', { id: qdev, filename: image, format: 'raw' });
	}

	async deleteVm(_nodeId: string, vmId: string, options: DeleteOptions): Promise<void> {
		const def = await this.definition(vmId);
		const dir = this.dir(vmId);
		if (def.origin === 'adopted') {
			// Only forget it: the process and its disks are not ours to stop or remove.
			this.closeQmp(vmId);
			await fs.promises.rm(dir, { recursive: true, force: true });
			this.log.info(`Detached from ${def.name} (still running)`);
			return;
		}
		if (await this.runtime(vmId)) await this.forceStop(vmId);
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
		if (!hasControlChannel(runtime)) {
			throw new ProviderError(`${def.name} was started outside VM Manager without a control socket: it cannot be asked to shut down. Use Power off, or restart it from here.`, 'unsupported');
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

	/** Starts are serialized: see `SerialQueue`. */
	private start(def: VmDefinition): Promise<void> {
		return this.startQueue.run(() => this.startWithRetry(def));
	}

	/** Local ports used by the QEMU processes that are running now (any VM of this cluster). */
	private async portsInUse(): Promise<Set<number>> {
		const used = new Set<number>();
		for (const def of await this.definitions()) {
			const runtime = await this.runtime(def.id);
			for (const port of [runtime?.qmpPort, runtime?.vncPort, runtime?.serialPort, runtime?.agentPort]) if (port) used.add(port);
		}
		return used;
	}

	private async startWithRetry(def: VmDefinition): Promise<void> {
		for (const disk of def.disks) {
			if (!fs.existsSync(disk)) throw new ProviderError(`Disk not found: ${disk}`, 'invalid');
		}
		if (def.cdrom && !fs.existsSync(def.cdrom)) throw new ProviderError(`ISO not found: ${def.cdrom}`, 'invalid');
		// A port that something else (another program, a VM of another window) took after our probe:
		// QEMU says so and exits; try again with different ports.
		const rejected = new Set<number>();
		for (let attempt = 1; ; attempt++) {
			const avoid = new Set([...(await this.portsInUse()), ...rejected]);
			const runtime: VmRuntime = {
				pid: 0,
				qmpPort: await freePort(undefined, undefined, avoid),
				vncPort: await freePort(5900, 5999, avoid),
				serialPort: def.serial ? await freePort(undefined, undefined, avoid) : undefined,
				agentPort: await freePort(undefined, undefined, avoid),
				startedAt: Date.now()
			};
			try {
				await this.launch(def, runtime);
				return;
			} catch (error) {
				if (attempt >= 3 || !isPortConflict((error as Error).message)) throw error;
				for (const port of [runtime.qmpPort, runtime.vncPort, runtime.serialPort, runtime.agentPort]) if (port) rejected.add(port);
				this.log.warn(`${def.name}: a local port was already in use, retrying with other ports (attempt ${attempt + 1} of 3)`);
			}
		}
	}

	private async launch(def: VmDefinition, runtime: VmRuntime): Promise<void> {
		const dir = this.dir(def.id);
		const args = buildArgs(def, runtime, {
			accelerators: usableAccelerators(defaultAccelerators(process.platform, this.accelerator), this.qemu.accelerators),
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
		if (!port && kind === 'vnc') throw new ProviderError('This VM has no VNC server on localhost (it may use a native window or a socket).', 'unavailable');
		if (!port) throw new ProviderError('The serial console is disabled for this VM. Enable it in the settings and restart the VM.', 'unavailable');
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.connect({ port, host: '127.0.0.1' });
			s.once('connect', () => resolve(s));
			s.once('error', reject);
		});
		socket.setNoDelay(true);
		return { stream: socket, dispose: () => socket.destroy() };
	}

	// -----------------------------------------------------------------------------------------
	// Attach to running VMs, import from files
	// -----------------------------------------------------------------------------------------

	/** Pids of every QEMU this extension knows (running managed or adopted VMs). */
	private async knownPids(): Promise<Set<number>> {
		const pids = new Set<number>();
		for (const def of await this.definitions()) {
			const runtime = await this.runtime(def.id);
			if (runtime) pids.add(runtime.pid);
		}
		return pids;
	}

	private async scanRunning(): Promise<ExternalVm[]> {
		return findExternalVms(await listProcesses(), await this.knownPids());
	}

	async scanExternalVms(): Promise<ExternalVmInfo[]> {
		return (await this.scanRunning()).map((vm) => ({
			id: String(vm.pid),
			name: vm.name,
			detail: `pid ${vm.pid} · ${vm.cpus} CPU · ${vm.memoryMB >= 1024 ? `${Math.round((vm.memoryMB / 1024) * 10) / 10} GB` : `${vm.memoryMB} MB`}${vm.disks.length ? ` · ${path.basename(vm.disks[0]!)}` : ''}`,
			controllable: !!vm.qmp,
			hint: vm.qmp ? undefined : 'No control socket (-qmp): it can only be observed and powered off. Restart it from VM Manager for full control.'
		}));
	}

	async adoptExternalVm(_nodeId: string, externalId: string): Promise<{ vm: VmInfo; warning?: string }> {
		const found = (await this.scanRunning()).find((vm) => String(vm.pid) === externalId);
		if (!found) throw new ProviderError('That QEMU process is gone, or is already managed. Scan again.', 'notFound');
		const id = randomUUID();
		const dir = this.dir(id);
		await fs.promises.mkdir(dir, { recursive: true });
		try {
			const def: VmDefinition = {
				id,
				name: await this.uniqueName(found.name),
				cpus: found.cpus,
				memoryMB: found.memoryMB,
				cpuModel: 'unknown',
				firmware: 'bios',
				disks: found.disks,
				diskBus: 'sata',
				cdrom: found.cdrom,
				nic: 'none',
				vga: 'std',
				serial: false,
				notes: `Attached to an existing QEMU process (pid ${found.pid}).`,
				origin: 'adopted',
				createdAt: Date.now()
			};
			const runtime: VmRuntime = {
				pid: found.pid,
				qmpPort: found.qmp?.port ?? 0,
				qmpHost: found.qmp?.host,
				qmpSocket: found.qmp?.socket,
				vncPort: found.vncPort ?? 0,
				startedAt: (await processStartedAt(found.pid)) ?? Date.now(),
				external: true
			};
			// Runtime first: a definition without one is an adopted VM that is gone, and gets cleaned up.
			await fs.promises.writeFile(path.join(dir, 'runtime.json'), JSON.stringify(runtime, null, 2));
			await this.saveDefinition(def);
			let warning: string | undefined;
			if (!found.qmp) {
				warning = `${def.name} has no control socket: it is listed, but can only be observed and powered off.`;
			} else {
				try {
					await this.client(id, runtime);
				} catch (error) {
					// QMP serves one client at a time: libvirt, UTM or another tool may hold it.
					this.closeQmp(id);
					warning = `Could not talk to the control socket of ${def.name} (${(error as Error).message}). Another program may be using it; it is listed as observe-only until it is free.`;
					await fs.promises.writeFile(path.join(dir, 'runtime.json'), JSON.stringify({ ...runtime, qmpPort: 0, qmpSocket: undefined }, null, 2));
				}
			}
			this.log.info(`Attached to pid ${found.pid} as ${def.name}${warning ? `: ${warning}` : ''}`);
			this.changes.fire({ nodeId: NODE_ID, vmId: id });
			return { vm: { id, name: def.name, state: 'running', cpus: def.cpus, memoryMB: def.memoryMB, origin: 'adopted', controllable: !warning }, warning };
		} catch (error) {
			await fs.promises.rm(dir, { recursive: true, force: true });
			throw error;
		}
	}

	/** `name`, or `name (2)`, `name (3)` … when taken. */
	private async uniqueName(wanted: string): Promise<string> {
		const base = wanted.replace(/[^\w .()\-]/g, '_').slice(0, 56).trim() || 'imported';
		const taken = new Set((await this.definitions()).map((d) => d.name.toLowerCase()));
		let name = base;
		for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
		return name;
	}

	private async folderInput(folder: string): Promise<FolderInput> {
		const files = await walkFiles(folder);
		const libvirt = new Map<string, string>();
		const vmJson = new Map<string, NonNullable<ReturnType<FolderInput['vmJson']['get']>>>();
		for (const file of files) {
			const lower = file.toLowerCase();
			try {
				if (lower.endsWith('.xml')) {
					if ((await fs.promises.stat(file)).size > 1_000_000) continue;
					const text = await fs.promises.readFile(file, 'utf8');
					if (text.includes('<domain')) libvirt.set(file, text);
				} else if (path.basename(lower) === 'vm.json') {
					const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>;
					if (Array.isArray(parsed.disks)) vmJson.set(file, parsed as never);
				}
			} catch {
				// unreadable or not what it looks like
			}
		}
		return { files, libvirt, vmJson };
	}

	/** Candidates minus the ones whose disks a managed VM already uses. */
	private async folderCandidates(folder: string): Promise<FolderCandidate[]> {
		if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new ProviderError(`Not a folder: ${folder}`, 'invalid');
		const managed = new Set<string>();
		for (const def of await this.definitions()) for (const disk of def.disks) managed.add(path.resolve(disk));
		return candidatesFromFolder(await this.folderInput(folder)).filter(
			(c) => c.disks.length > 0 && !c.disks.every((d) => managed.has(path.resolve(d)))
		);
	}

	async scanImportFolder(_nodeId: string, folder: string): Promise<ImportCandidate[]> {
		const label = { 'vm.json': 'VM Manager definition', libvirt: 'libvirt definition', utm: 'UTM bundle', image: 'disk image' } as const;
		return (await this.folderCandidates(folder)).map((c) => ({
			id: c.id,
			name: c.name,
			source: label[c.source],
			detail: [c.cpus ? `${c.cpus} CPU` : undefined, c.memoryMB ? `${c.memoryMB} MB` : undefined, `${c.disks.length} disk${c.disks.length === 1 ? '' : 's'}`, c.disks[0] ? path.basename(c.disks[0]) : undefined]
				.filter(Boolean)
				.join(' · ')
		}));
	}

	async importFromFolder(_nodeId: string, folder: string, candidateIds: string[], options: ImportOptions): Promise<VmInfo[]> {
		const wanted = new Set(candidateIds);
		const chosen = (await this.folderCandidates(folder)).filter((c) => wanted.has(c.id));
		if (!chosen.length) throw new ProviderError('Nothing to import: the selection is gone from the folder', 'notFound');
		const imported: VmInfo[] = [];
		for (const candidate of chosen) {
			for (const file of [...candidate.disks, ...(candidate.cdrom ? [candidate.cdrom] : [])]) {
				if (!fs.existsSync(file)) throw new ProviderError(`File not found: ${file}`, 'invalid');
			}
			const id = randomUUID();
			const dir = this.dir(id);
			await fs.promises.mkdir(dir, { recursive: true });
			try {
				const disks: string[] = [];
				for (const [index, disk] of candidate.disks.entries()) {
					if (options.copy) {
						const target = path.join(dir, `disk${index}${path.extname(disk).toLowerCase()}`);
						await fs.promises.copyFile(disk, target);
						disks.push(target);
					} else {
						disks.push(disk);
					}
				}
				const uefi = !!candidate.uefi && !!this.qemu.firmwareCode;
				const def: VmDefinition = {
					id,
					name: await this.uniqueName(candidate.name),
					cpus: Math.max(1, candidate.cpus ?? 2),
					memoryMB: Math.max(128, candidate.memoryMB ?? 2048),
					cpuModel: 'max',
					firmware: uefi ? 'uefi' : 'bios',
					disks,
					diskBus: 'sata',
					cdrom: candidate.cdrom,
					nic: 'e1000',
					mac: randomMac(),
					vga: 'std',
					serial: true,
					notes: options.copy ? `Imported (copied) from ${candidate.id}.` : `Imported from ${candidate.id}; the disks stay where they are.`,
					origin: 'imported',
					createdAt: Date.now()
				};
				if (uefi) await this.ensureVars(def);
				await this.saveDefinition(def);
				this.log.info(`Imported ${def.name} (${options.copy ? 'copied' : 'referenced'}) from ${candidate.id}`);
				imported.push({ id, name: def.name, state: 'stopped', cpus: def.cpus, memoryMB: def.memoryMB, origin: 'imported' });
			} catch (error) {
				await fs.promises.rm(dir, { recursive: true, force: true });
				throw error;
			}
		}
		this.changes.fire({ nodeId: NODE_ID, vmId: imported[0]!.id });
		return imported;
	}

	dispose(): void {
		for (const id of [...this.qmp.keys()]) this.closeQmp(id);
		this.changes.dispose();
	}
}

/** An adopted VM may have no monitor at all (see `ExternalVm.qmp`). */
function hasControlChannel(runtime: VmRuntime): boolean {
	return !!(runtime.qmpSocket || runtime.qmpPort);
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

function randomMac(): string {
	const byte = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
	return `52:54:00:${byte()}:${byte()}:${byte()}`;
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

/**
 * A free localhost port; within [min, max] when given (VNC needs 5900 + display). Ports in `avoid`
 * (held by running VMs, or just refused) are skipped. Note that this only *probes*: the port is not
 * held after it returns, see `SerialQueue`.
 */
export async function freePort(min?: number, max?: number, avoid: ReadonlySet<number> = new Set()): Promise<number> {
	if (min === undefined) {
		for (let tries = 0; tries < 20; tries++) {
			const port = await tryListen(0);
			if (!port) throw new ProviderError('No free TCP port available');
			if (!avoid.has(port)) return port;
		}
		throw new ProviderError('No free TCP port available');
	}
	for (let port = min; port <= (max ?? min); port++) {
		if (!avoid.has(port) && (await tryListen(port))) return port;
	}
	throw new ProviderError(`No free TCP port between ${min} and ${max}`);
}
