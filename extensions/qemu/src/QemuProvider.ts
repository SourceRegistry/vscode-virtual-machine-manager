import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
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
	type CreateProgress,
	type DeleteOptions,
	type DiskDevice,
	type DiskExportOptions,
	type DiskProgress,
	type DiskStats,
	type NewDisk,
	type Disposable,
	type Event,
	type ExternalVmInfo,
	type FieldSchema,
	type FieldValues,
	type GuestCommand,
	type GuestCommandResult,
	type HypervisorProvider,
	type ImportCandidate,
	type ImportOptions,
	type PassthroughDevice,
	type PassthroughInfo,
	type PassthroughPlan,
	type Logger,
	type NodeInfo,
	type PortForward,
	type SecretBag,
	type Snapshot,
	type TransferProgress,
	type PowerAction,
	type ProviderContext,
	type VmConfig,
	type VmDetails,
	type VmInfo,
	type VmState,
	type VmStats
} from '@vmm/sdk';
import { ARCHS, ARCH_LABEL, acceleratorsFor, archFromName, guestArch, hostArch, isNative, normalizeHardware, type Arch } from './arch';
import { buildArgs, usableAccelerators, type DiskBus, type Firmware, type NicModel, type VgaModel, type VmDefinition, type VmRuntime } from './definition';
import { detectQemu, type ArchInstallation, type QemuInstallation } from './detect';
import { copyFromGuest, copyToGuest, explainAgentError, runInGuest, type AgentCall } from '@vmm/sdk/guest';
import { GuestAgentClient } from './GuestAgent';
import { balloonUsedMB } from './balloon';
import { QmpClient, type QmpEvent } from './QmpClient';
import { freeLocalPort, LocalHost, type Host } from './host';
import { SshHost, validateSshTarget } from './sshHost';
import { buildIso, cloudFields, cloudInitProblem, ensureImage, findImage, hostnameFor, imageFileName, metaData, parseKeys, sha512Crypt, SOURCE_ISO, userData } from '@vmm/sdk/provisioning';
import { cloneDefinition } from './clone';
import { addDiskProblem, convertArgs, convertTarget, diskIndex, exportArgs, newDiskFile } from './disks';
import { commonSnapshots, qmpSnapshots, snapshotNameProblem, type QemuSnapshotInfo, type QmpSnapshotBlock } from './snapshots';
import { walkFiles } from './hostProcess';
import { iommuEnabled, listPciHost, listUsbHost, pciDriver, runPrivileged } from './hostDevices';
import {
	assessVfio,
	bindScript,
	isBridge,
	pciClassName,
	PCI_ADDRESS,
	parseUsbDeviceId,
	releaseScript,
	usbAddArguments,
	usbDeviceId,
	usbKey,
	USB_ID_PREFIX,
	type PciHostDevice
} from './passthrough';
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
import { telnetStream } from './telnet';

const NODE_ID = 'local';

/** What `qemu-img info --output=json` reports about an image. */
interface ImageInfo {
	'virtual-size'?: number;
	'actual-size'?: number;
	format?: string;
}

const VM_NAME = /^[\w .()-]{1,64}$/;

/** Shown only for a remote connection. `default` covers clusters saved before the choice existed. */
const SSH_ONLY = { key: 'connection', equals: 'ssh', default: 'local' } as const;
/** The questions the host picker leaves open; clusters saved before it existed ask them all. */
const ASK_USER = { key: 'sshAskUser', equals: true, default: true } as const;
const ASK_PORT = { key: 'sshAskPort', equals: true, default: true } as const;
const ASK_AUTH = { key: 'sshAskAuth', equals: true, default: true } as const;

const CONNECTION_SCHEMA: FieldSchema[] = [
	{
		key: 'connection',
		label: 'Connection',
		type: 'select',
		default: 'local',
		required: true,
		options: [
			{ value: 'local', label: 'Local', description: 'QEMU on this computer' },
			{ value: 'ssh', label: 'Remote (SSH)', description: 'QEMU on another Linux computer, reached with ssh' }
		]
	},
	{
		key: 'sshHost',
		label: 'SSH host',
		type: 'sshHost',
		required: true,
		showWhen: SSH_ONLY,
		group: 'Remote host',
		description: 'A host name, an address or an alias of your ~/.ssh/config (jump hosts and keys from there apply).',
		placeholder: 'lab.example.com'
	},
	// Set by the host picker: what the ssh config (or user@host) already answers is not asked again.
	{ key: 'sshAskUser', label: 'Ask for the SSH user', type: 'checkbox', readonly: true, showWhen: SSH_ONLY },
	{ key: 'sshAskPort', label: 'Ask for the SSH port', type: 'checkbox', readonly: true, showWhen: SSH_ONLY },
	{ key: 'sshAskAuth', label: 'Ask how to sign in', type: 'checkbox', readonly: true, showWhen: SSH_ONLY },
	{ key: 'sshUser', label: 'SSH user', type: 'text', showWhen: ASK_USER, group: 'Remote host', description: 'Empty: your user name on this computer.' },
	{ key: 'sshPort', label: 'SSH port', type: 'number', min: 1, max: 65535, showWhen: ASK_PORT, group: 'Remote host', description: 'Empty: 22.' },
	{
		key: 'sshAuth',
		label: 'Sign in with',
		type: 'select',
		default: 'agent',
		required: true,
		showWhen: ASK_AUTH,
		group: 'Remote host',
		options: [
			{ value: 'agent', label: 'ssh-agent or default keys', description: 'What ssh finds itself' },
			{ value: 'key', label: 'A key file', description: 'A private key on this computer' },
			{ value: 'password', label: 'A password', description: 'Kept in the system keychain' }
		]
	},
	{
		key: 'sshIdentityFile',
		label: 'SSH key',
		type: 'text',
		required: true,
		showWhen: { key: 'sshAuth', equals: 'key' },
		group: 'Remote host',
		description: 'Path of a private key on this computer (a key with a passphrase must be in ssh-agent).',
		placeholder: '~/.ssh/id_ed25519'
	},
	{
		key: 'sshPassword',
		label: 'SSH password',
		type: 'password',
		secret: true,
		required: true,
		showWhen: { key: 'sshAuth', equals: 'password' },
		group: 'Remote host'
	},
	{
		key: 'qemuPath',
		label: 'QEMU directory',
		type: 'directory',
		remotePath: SSH_ONLY,
		description: 'Directory with qemu-system-x86_64 and qemu-img (on the SSH host when one is set). Leave empty to detect automatically.',
		placeholder: 'Detect automatically'
	},
	{
		key: 'vmDirectory',
		label: 'VM storage directory',
		type: 'directory',
		remotePath: SSH_ONLY,
		description: 'Where VM definitions and disks are stored (on the SSH host when one is set). Leave empty for the extension storage, or ~/vmm-qemu on an SSH host.',
		placeholder: 'Default'
	},
	{
		key: 'imageDirectory',
		label: 'Image directory',
		type: 'directory',
		remotePath: SSH_ONLY,
		description: 'Where downloaded cloud images are kept (on the SSH host when one is set). Leave empty to keep them next to the VM storage directory.',
		placeholder: 'Default'
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
	/** The ssh program (tests only). */
	sshCommand?: string;
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

	remoteLabel(cluster: ClusterConfig): string | undefined {
		if (!isRemote(cluster)) return undefined;
		const name = String(cluster.config.sshHost ?? '').trim();
		const user = String(cluster.config.sshUser ?? '').trim();
		return `ssh ${user && !name.includes('@') ? `${user}@` : ''}${name || '…'}`;
	}

	async testConnection(cluster: ClusterConfig, secrets: SecretBag = {}): Promise<void> {
		const host = this.hostFor(cluster, secrets);
		try {
			await host.ping();
			await detectQemu(this.qemuPath(cluster), host);
		} finally {
			host.dispose();
		}
	}

	async connect(cluster: ClusterConfig, secrets: SecretBag, context: ProviderContext): Promise<ClusterConnection> {
		const host = this.hostFor(cluster, secrets);
		try {
			await host.ping();
			const installation = await detectQemu(this.qemuPath(cluster), host);
			context.log.info(`Using QEMU ${installation.version} from ${installation.directory}${host.remote ? ` on ${host.label}` : ''}`);
			let vmDirectory = cluster.config.vmDirectory as string | undefined;
			if (!vmDirectory) {
				if (host.remote) {
					const home = (await host.exec('sh', ['-c', 'echo "$HOME"'], { timeout: 30_000 })).stdout.trim();
					vmDirectory = host.path.join(home || '~', 'vmm-qemu', 'vms');
				} else {
					vmDirectory = path.join(context.storagePath, 'vms');
				}
			}
			await host.mkdir(vmDirectory);
			const timeout = Number(cluster.config.shutdownTimeout);
			const shutdownTimeoutMs = (Number.isFinite(timeout) && timeout >= 5 ? Math.min(timeout, 600) : 30) * 1000;
			const info = await host.info();
			const imageDirectory = (cluster.config.imageDirectory as string | undefined) || host.path.join(host.path.dirname(vmDirectory), 'images');
			return new QemuConnection(installation, vmDirectory, String(cluster.config.accelerator ?? 'auto'), context.log, shutdownTimeoutMs, host, info.cpus, imageDirectory);
		} catch (error) {
			host.dispose();
			throw error;
		}
	}

	private hostFor(cluster: ClusterConfig, secrets: SecretBag): Host {
		if (!isRemote(cluster)) return new LocalHost();
		const name = String(cluster.config.sshHost ?? '').trim();
		if (!name) throw new ProviderError('Enter the SSH host to connect to.', 'invalid');
		const port = Number(cluster.config.sshPort);
		// `user@host` as typed in the picker; an explicit SSH user wins.
		const at = name.lastIndexOf('@');
		const method = String(cluster.config.sshAuth ?? '');
		const password = method === 'password' ? secrets.sshPassword : undefined;
		if (method === 'password' && !password) throw new ProviderError('Enter the SSH password.', 'invalid');
		const target = {
			host: at > 0 ? name.slice(at + 1) : name,
			user: String(cluster.config.sshUser ?? '').trim() || (at > 0 ? name.slice(0, at) : undefined),
			port: Number.isFinite(port) && port > 0 ? port : undefined,
			// The key only applies when that is how to sign in (older clusters have a key and no choice).
			identityFile: method === 'key' || method === '' ? String(cluster.config.sshIdentityFile ?? '').trim() || undefined : undefined,
			viaPassword: !!password
		};
		const problem = validateSshTarget(target);
		if (problem) throw new ProviderError(problem, 'invalid');
		return new SshHost(target, { password, ...(this.options.sshCommand ? { command: this.options.sshCommand, anyPlatform: true } : {}) });
	}

	private qemuPath(cluster: ClusterConfig): string | undefined {
		// The VS Code setting names a directory on this computer: it does not apply to another one.
		return (cluster.config.qemuPath as string | undefined) || (isRemote(cluster) ? undefined : this.options.defaultQemuPath()) || undefined;
	}
}

/** Remote when chosen; a cluster saved with an SSH host but before the choice existed counts as remote too. */
function isRemote(cluster: ClusterConfig): boolean {
	return cluster.config.connection === 'ssh' || (cluster.config.connection === undefined && !!cluster.config.sshHost);
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
	readonly capabilities: Capabilities;
	private readonly baseCapabilities: Capabilities = {
		create: true,
		edit: true,
		delete: true,
		power: ['start', 'shutdown', 'reboot', 'stop'],
		consoles: ['vnc', 'serial'],
		preview: false,
		external: false,
		media: true,
		snapshots: true,
		snapshotRevertNeedsStopped: true,
		clone: true,
		cloneNeedsStopped: true,
		templates: true,
		details: true,
		forwards: true,
		adopt: true,
		passthrough: true,
		importFolder: true,
		stats: true,
		guestExec: true,
		guestFiles: true,
		diskOperations: ['add', 'remove', 'resize', 'convert', 'export'],
		diskOperationsWhileRunning: ['resize'],
		diskExportConverts: true
	};
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
		private readonly shutdownTimeoutMs = 30_000,
		private readonly host: Host = new LocalHost(),
		private readonly cpuCount = os.cpus().length,
		private readonly imageDirectory = host.path.join(host.path.dirname(vmDirectory), 'images')
	) {
		// Importing from a folder and PCI/USB passthrough read this computer's own files and devices.
		const capabilities = host.remote ? { ...this.baseCapabilities, passthrough: false, importFolder: false, remotePaths: true } : this.baseCapabilities;
		this.capabilities = { ...capabilities, shutdownTimeoutSeconds: Math.round(shutdownTimeoutMs / 1000) };
	}

	/** Software emulation: another architecture than the host's, or no accelerator for this one (TCG only). */
	private emulated(arch: Arch): boolean {
		if (!this.native(arch)) return true;
		try {
			return (this.acceleratorsOf(arch)[0]?.split(',')[0] ?? 'tcg') === 'tcg';
		} catch {
			return false;
		}
	}

	/** QEMU's own output (stderr) for a VM started here; an attached one has none. */
	async readVmLog(_nodeId: string, vmId: string): Promise<string | undefined> {
		return this.host.readFile(this.host.path.join(this.dir(vmId), 'qemu.log')).catch(() => undefined);
	}

	/** Whether guests of this architecture run natively on the host (the VM host, not this computer). */
	private native(arch: Arch): boolean {
		return isNative(arch, hostArch(this.host.arch));
	}

	/** The emulator, accelerators and firmware for a guest architecture. */
	private install(arch: Arch): ArchInstallation {
		const found = this.qemu.archs[arch];
		if (!found) {
			throw new ProviderError(`${ARCH_LABEL[arch]} guests need qemu-system-${arch}, which was not found in ${this.qemu.directory}.`, 'unavailable');
		}
		return found;
	}

	private installedArchs(): Arch[] {
		return ARCHS.filter((a) => this.qemu.archs[a]);
	}

	/** Accelerators for a guest: the hypervisor only for the host's own architecture, TCG otherwise. */
	private acceleratorsOf(arch: Arch): string[] {
		return usableAccelerators(acceleratorsFor(arch, this.host.platform, this.accelerator, hostArch(this.host.arch)), this.install(arch).accelerators);
	}

	// -----------------------------------------------------------------------------------------
	// Storage
	// -----------------------------------------------------------------------------------------

	private dir(id: string): string {
		if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProviderError('Invalid virtual machine id', 'invalid');
		return this.host.path.join(this.vmDirectory, id);
	}

	private async definitions(): Promise<VmDefinition[]> {
		const result: VmDefinition[] = [];
		for (const [, raw] of await this.host.readChildren(this.vmDirectory, 'vm.json')) {
			try {
				result.push(JSON.parse(raw) as VmDefinition);
			} catch {
				// not a VM directory
			}
		}
		return result;
	}

	private async definition(id: string): Promise<VmDefinition> {
		try {
			return JSON.parse(await this.host.readFile(this.host.path.join(this.dir(id), 'vm.json'))) as VmDefinition;
		} catch {
			throw new ProviderError('Virtual machine not found', 'notFound');
		}
	}

	private async saveDefinition(def: VmDefinition): Promise<void> {
		await this.host.writeFile(this.host.path.join(this.dir(def.id), 'vm.json'), JSON.stringify(def, null, 2));
	}

	private async runtime(id: string): Promise<VmRuntime | undefined> {
		try {
			const runtime = JSON.parse(await this.host.readFile(this.host.path.join(this.dir(id), 'runtime.json'))) as VmRuntime;
			if (await this.host.isAlive(runtime.pid)) return runtime;
		} catch {
			return undefined;
		}
		await this.clearRuntime(id);
		return undefined;
	}

	private async clearRuntime(id: string): Promise<void> {
		this.closeQmp(id);
		await this.host.rm(this.host.path.join(this.dir(id), 'runtime.json'));
	}

	// -----------------------------------------------------------------------------------------
	// QMP
	// -----------------------------------------------------------------------------------------

	private client(id: string, runtime: VmRuntime): Promise<QmpClient> {
		const existing = this.qmp.get(id);
		if (existing) return existing;
		const port = runtime.qmpPort;
		const timeout = this.host.remote ? 10_000 : 3000;
		const target = runtime.qmpSocket
			? this.host.connectSocket(runtime.qmpSocket).then((stream) => QmpClient.attach(stream, timeout))
			: port
				? this.host.connect(port, runtime.qmpHost).then((stream) => QmpClient.attach(stream, timeout))
				: undefined;
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
		const info = await this.host.info();
		const total = info.memoryMB;
		const available = info.availableMemoryMB;
		const installed = this.installedArchs();
		const native = installed.find((a) => this.native(a)) ?? installed[0]!;
		const active = this.acceleratorsOf(native)[0]?.split(',')[0] ?? 'tcg';
		return [
			{
				id: NODE_ID,
				name: info.hostname,
				status: 'online',
				cpus: info.cpus,
				cpuUsage: info.cpuLoad,
				memoryMB: total,
				memoryUsedMB: Math.max(0, total - available),
				description: `QEMU ${this.qemu.version}`,
				facts: [
					{ label: 'QEMU', value: this.qemu.version },
					{ label: 'Acceleration', value: active === 'tcg' ? 'Software emulation (TCG)' : `${active.toUpperCase()}${installed.length > 1 ? ` (${native})` : ''}` },
					{ label: 'Guest architectures', value: installed.map((a) => (this.native(a) ? `${a} (native)` : `${a} (emulated, slow)`)).join(', ') },
					{ label: 'Platform', value: this.host.remote ? `${info.platform} · ${this.host.label}` : info.platform }
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
				await this.host.rm(this.dir(def.id), { recursive: true });
				continue;
			}
			visible.push(def);
		}
		return Promise.all(
			visible.map(async (def) => {
				const runtime = await this.runtime(def.id);
				const state = await this.state(def, runtime);
				const consoles: ConsoleKind[] = [];
				if (!runtime || runtime.vncPort || runtime.vncSocket) consoles.push('vnc');
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
					macAddresses: def.mac ? [def.mac] : undefined,
					os: `${guestArch(def) === 'x86_64' && this.native(guestArch(def)) ? '' : `${guestArch(def)}${this.native(guestArch(def)) ? '' : ' (emulated)'} · `}${def.firmware.toUpperCase()} · ${(guestArch(def) === 'aarch64' ? 'virtio' : def.diskBus).toUpperCase()}`,
					consoles,
					mediaInserted,
					origin: def.origin,
					template: def.template,
					controllable: runtime ? hasControlChannel(runtime) : undefined,
					emulated: this.emulated(guestArch(def)) || undefined
				} satisfies VmInfo;
			})
		);
	}

	async getCreateSchema(): Promise<FieldSchema[]> {
		const installed = this.installedArchs();
		const cached = new Set((await this.host.readdir(this.imageDirectory).catch(() => [])).filter((e) => e.name.endsWith('.verified')).map((e) => e.name.slice(0, -'.verified'.length)));
		const defaultArch = installed.find((a) => this.native(a)) ?? installed[0]!;
		const archField: FieldSchema[] =
			installed.length > 1
				? [
						{
							key: 'arch',
							label: 'Architecture',
							type: 'select',
							required: true,
							showWhen: SOURCE_ISO,
							default: defaultArch,
							options: installed.map((a) => ({ value: a, label: `${ARCH_LABEL[a]}${this.native(a) ? ' — native, full speed' : ' — emulated, much slower'}` })),
							description: 'A guest of the same architecture as this computer runs with hardware acceleration. Any other is emulated in software, typically 10 to 50 times slower.'
						}
					]
				: [];
		return [
			{ key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'my-vm', description: 'Letters, digits, spaces and . _ ( ) -' },
			{
				key: 'source',
				label: 'Set up from',
				type: 'select',
				required: true,
				default: 'iso',
				options: [
					{ value: 'iso', label: 'An installer ISO', description: 'Install the operating system yourself' },
					{ value: 'cloud', label: 'A cloud image (cloud-init)', description: 'Debian or Ubuntu, ready in a minute: no installer' }
				]
			},
			...archField,
			{ key: 'cpus', label: 'Processors', type: 'number', unit: 'cores', min: 1, max: this.cpuCount, default: Math.min(2, this.cpuCount), required: true },
			{ key: 'memoryMB', label: 'Memory', type: 'number', unit: 'MB', min: 128, default: 2048, required: true },
			{ key: 'diskGB', label: 'Disk size', type: 'number', unit: 'GB', min: 1, max: 16384, default: 32, required: true },
			{ key: 'cdrom', label: 'Installation media (ISO)', type: 'file', remotePath: this.host.remote, showWhen: SOURCE_ISO, filters: { 'Disk images': ['iso', 'img'] } },
			...cloudFields({ installed, remote: this.host.remote, cached }),
			{
				key: 'firmware',
				label: 'Firmware',
				type: 'select',
				required: true,
				default: this.install(defaultArch).firmwareCode ? 'uefi' : 'bios',
				options: this.install(defaultArch).firmwareCode ? FIRMWARE_OPTIONS : FIRMWARE_OPTIONS.filter((o) => o.value === 'bios'),
				description: 'ARM64 guests always use UEFI.'
			},
			{ key: 'diskBus', label: 'Disk controller', type: 'select', required: true, default: 'sata', options: DISK_BUS_OPTIONS, advanced: true },
			{ key: 'nic', label: 'Network adapter', type: 'select', required: true, default: 'e1000', options: NIC_OPTIONS, advanced: true },
			{ key: 'vga', label: 'Display adapter', type: 'select', required: true, default: 'std', options: VGA_OPTIONS, advanced: true },
			{ key: 'serial', label: 'Serial console', type: 'checkbox', default: true, advanced: true },
			{ key: 'notes', label: 'Notes', type: 'textarea', advanced: true }
		];
	}

	async createVm(_nodeId: string, values: FieldValues, progress?: (update: CreateProgress) => void): Promise<VmInfo> {
		const name = String(values.name ?? '').trim();
		if (!VM_NAME.test(name)) throw new ProviderError('Use 1–64 letters, digits, spaces or . _ ( ) - for the name', 'invalid');
		if ((await this.definitions()).some((d) => d.name.toLowerCase() === name.toLowerCase())) {
			throw new ProviderError(`A virtual machine named "${name}" already exists`, 'invalid');
		}
		if (values.source === 'cloud') return this.createFromCloudImage(name, values, progress);
		const installed = this.installedArchs();
		const arch = (values.arch as Arch | undefined) ?? installed.find((a) => this.native(a)) ?? installed[0]!;
		const firmwareCode = this.install(arch).firmwareCode;
		const hardware = normalizeHardware(arch, {
			firmware: (values.firmware as Firmware) ?? 'bios',
			diskBus: (values.diskBus as DiskBus) ?? 'sata',
			nic: (values.nic as NicModel) ?? 'e1000',
			vga: (values.vga as VgaModel) ?? 'std'
		});
		if (hardware.firmware === 'uefi' && !firmwareCode) {
			throw new ProviderError(`UEFI firmware for ${ARCH_LABEL[arch]} was not found next to QEMU (edk2-${arch === 'aarch64' ? 'aarch64' : 'x86_64'}-code.fd).`, 'unavailable');
		}
		const id = randomUUID();
		const dir = this.dir(id);
		await this.host.mkdir(dir);
		try {
			const disk = this.host.path.join(dir, 'disk0.qcow2');
			const sizeGB = Math.max(1, Math.round(Number(values.diskGB ?? 32)));
			await this.host.exec(this.qemu.img, ['create', '-f', 'qcow2', disk, `${sizeGB}G`], { timeout: 60_000 });
			const def: VmDefinition = {
				id,
				name,
				arch,
				cpus: Number(values.cpus ?? 2),
				memoryMB: Number(values.memoryMB ?? 2048),
				cpuModel: 'max',
				firmware: hardware.firmware,
				disks: [disk],
				diskBus: hardware.diskBus,
				cdrom: (values.cdrom as string | undefined) || undefined,
				nic: hardware.nic,
				mac: randomMac(),
				vga: hardware.vga,
				serial: values.serial !== false,
				notes: (values.notes as string | undefined) || undefined,
				createdAt: Date.now()
			};
			if (def.firmware === 'uefi') await this.ensureVars(def);
			await this.saveDefinition(def);
			this.log.info(`Created ${name} in ${dir}`);
			return { id, name, state: 'stopped', cpus: def.cpus, memoryMB: def.memoryMB };
		} catch (error) {
			await this.host.rm(dir, { recursive: true });
			throw error;
		}
	}

	/**
	 * A machine from a cloud image: the image is downloaded (verified, cached) or taken from a file, copied to
	 * the machine's own qcow2 disk, enlarged, and a cloud-init seed disk with the user, key and host name is
	 * attached as its CD drive. Nothing is installed by hand: the first boot sets everything up.
	 */
	private async createFromCloudImage(name: string, values: FieldValues, progress?: (update: CreateProgress) => void): Promise<VmInfo> {
		const choice = String(values.cloudImage ?? '');
		const image = choice === 'custom' ? undefined : findImage(choice);
		if (choice !== 'custom' && !image) throw new ProviderError('Choose a cloud image.', 'invalid');
		const installed = this.installedArchs();
		const arch: Arch = image?.arch ?? installed.find((a) => this.native(a)) ?? installed[0]!;
		const firmwareCode = this.install(arch).firmwareCode;

		// Everything that can be wrong is checked before anything is downloaded.
		const user = String(values.ciUser ?? '').trim();
		const hostname = String(values.ciHostname ?? '').trim() || hostnameFor(name);
		const sshKeys = parseKeys(values.ciSshKey as string | undefined);
		const password = String(values.ciPassword ?? '');
		const custom = String(values.ciUserData ?? '');
		const passwordHash = password ? sha512Crypt(password) : undefined;
		if (!custom.trim()) {
			const problem = cloudInitProblem({ hostname, user, sshKeys, passwordHash });
			if (problem) throw new ProviderError(problem, 'invalid');
		}
		const customFile = String(values.cloudImageFile ?? '').trim();
		if (!image) {
			if (!customFile) throw new ProviderError('Enter the path of the disk image.', 'invalid');
			if (!(await this.host.exists(customFile))) throw new ProviderError(`Image not found: ${customFile}`, 'invalid');
		}
		const hardware = normalizeHardware(arch, { firmware: firmwareCode ? 'uefi' : 'bios', diskBus: 'virtio', nic: 'virtio-net-pci', vga: 'std' });
		if (hardware.firmware === 'uefi' && !firmwareCode) throw new ProviderError(`UEFI firmware for ${ARCH_LABEL[arch]} was not found next to QEMU.`, 'unavailable');

		const phase = (from: number, to: number) => (p: { phase: string; done?: number; total?: number }) => {
			const fraction = p.done !== undefined && p.total ? from + ((to - from) * p.done) / p.total : undefined;
			const text = p.phase === 'download' ? `Downloading ${image!.label}${p.total && p.done !== undefined ? ` — ${Math.round((100 * p.done) / p.total)}%` : ''}` : p.phase === 'verify' ? 'Verifying the checksum' : p.phase === 'checksum' ? 'Checking for the latest image' : 'Using the downloaded image';
			progress?.({ message: text, fraction });
		};
		const source = image ? await ensureImage(this.host, image, this.imageDirectory, { onProgress: phase(0.05, 0.85) }) : customFile;

		const id = randomUUID();
		const dir = this.dir(id);
		await this.host.mkdir(dir);
		try {
			progress?.({ message: 'Preparing the disk', fraction: 0.88 });
			const disk = this.host.path.join(dir, 'disk0.qcow2');
			try {
				await this.host.exec(this.qemu.img, ['convert', '-O', 'qcow2', source, disk], { timeout: 30 * 60_000 });
			} catch (error) {
				const detail = String((error as { stderr?: string }).stderr || (error as Error).message).trim().split('\n')[0];
				throw new ProviderError(`Could not read the image ${this.host.path.basename(source)}: ${detail}`, 'failed');
			}
			// Never shrink an image: the requested size only applies when it is larger.
			const wanted = Math.max(1, Math.round(Number(values.diskGB ?? 32)));
			const info = await this.imageInfo(disk);
			if (!info?.['virtual-size'] || info['virtual-size'] < wanted * 1024 ** 3) {
				await this.host.exec(this.qemu.img, ['resize', disk, `${wanted}G`], { timeout: 120_000 });
			}

			progress?.({ message: 'Writing the cloud-init disk', fraction: 0.94 });
			const seed = this.host.path.join(dir, 'seed.iso');
			await this.writeSeed(seed, id, { hostname, user, sshKeys, passwordHash, installAgent: values.ciAgent !== false, customUserData: custom });

			const def: VmDefinition = {
				id,
				name,
				arch,
				cpus: Number(values.cpus ?? 2),
				memoryMB: Number(values.memoryMB ?? 2048),
				cpuModel: 'max',
				firmware: hardware.firmware,
				disks: [disk],
				diskBus: hardware.diskBus,
				cdrom: seed,
				nic: hardware.nic,
				mac: randomMac(),
				vga: hardware.vga,
				serial: values.serial !== false,
				notes: `Set up by cloud-init from ${image ? image.label : this.host.path.basename(source)}. ${custom.trim() ? 'Custom user-data.' : `Sign in as ${user}.`}`,
				cloudInit: { user: custom.trim() ? '' : user, hostname, image: image?.id, sshKeys, passwordHash, installAgent: values.ciAgent !== false, customUserData: custom },
				createdAt: Date.now()
			};
			if (def.firmware === 'uefi') await this.ensureVars(def);
			await this.saveDefinition(def);
			progress?.({ message: 'Done', fraction: 1 });
			this.log.info(`Created ${name} from ${image ? imageFileName(image) : source} in ${dir}`);
			return { id, name, state: 'stopped', cpus: def.cpus, memoryMB: def.memoryMB };
		} catch (error) {
			await this.host.rm(dir, { recursive: true });
			throw error;
		}
	}

	/** A cloud-init `cidata` disk; `id` becomes the instance id, so each machine runs first-boot setup once, on its own. */
	private async writeSeed(file: string, id: string, options: { hostname: string; user: string; sshKeys?: string[]; passwordHash?: string; installAgent?: boolean; customUserData?: string }): Promise<void> {
		const full = { ...options, sshKeys: options.sshKeys ?? [], installAgent: options.installAgent !== false, customUserData: options.customUserData ?? '', instanceId: `vmm-${id}` };
		await this.host.writeBytes(
			file,
			buildIso(
				[
					{ name: 'user-data', data: Buffer.from(userData(full), 'utf8') },
					{ name: 'meta-data', data: Buffer.from(metaData(full), 'utf8') }
				],
				{ volumeId: 'cidata' }
			)
		);
	}

	async setTemplate(_nodeId: string, vmId: string, template: boolean): Promise<void> {
		const def = await this.definition(vmId);
		if (def.origin === 'adopted') throw new ProviderError('A VM that was attached from outside cannot become a template. Import it or recreate it here first.', 'unsupported');
		if (await this.runtime(vmId)) throw new ProviderError(`Shut down "${def.name}" first`, 'invalid');
		if (!!def.template === template) return;
		if (template) def.template = true;
		else delete def.template;
		await this.saveDefinition(def);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	private async ensureVars(def: VmDefinition): Promise<string | undefined> {
		const vars = this.host.path.join(this.dir(def.id), 'efivars.fd');
		if (await this.host.exists(vars)) return vars;
		const template = this.install(guestArch(def)).firmwareVarsTemplate;
		if (!template) return undefined;
		await this.host.copyFile(template, vars);
		return vars;
	}

	async getVmConfig(_nodeId: string, vmId: string): Promise<VmConfig> {
		const def = await this.definition(vmId);
		const running = !!(await this.runtime(vmId));
		const restart = running ? 'Applies after the next start.' : undefined;
		const arch = guestArch(def);
		const arm = arch === 'aarch64';
		const fixed = (what: string) => (arm ? `${what} is fixed for ARM64 guests.` : restart);
		const schema: FieldSchema[] = [
			{ key: 'name', label: 'Name', type: 'text', required: true, group: 'General' },
			{ key: 'arch', label: 'Architecture', type: 'text', readonly: true, group: 'General', description: this.native(arch) ? 'Runs with hardware acceleration.' : 'Emulated in software: much slower than a native guest.' },
			{ key: 'notes', label: 'Notes', type: 'textarea', group: 'General' },
			{ key: 'location', label: 'Location', type: 'text', readonly: true, group: 'General' },
			{ key: 'cpus', label: 'Processors', type: 'number', unit: 'cores', min: 1, max: this.cpuCount, required: true, group: 'Hardware', description: restart },
			{ key: 'memoryMB', label: 'Memory', type: 'number', unit: 'MB', min: 128, required: true, group: 'Hardware', description: restart },
			{ key: 'cpuModel', label: 'CPU model', type: 'text', required: true, group: 'Hardware', description: 'QEMU -cpu value, e.g. max, host, qemu64' },
			{ key: 'disks', label: 'Disks', type: 'text', readonly: true, group: 'Storage' },
			{ key: 'diskBus', label: 'Disk controller', type: 'select', required: true, readonly: arm, options: DISK_BUS_OPTIONS, group: 'Storage', description: fixed('The controller') },
			{ key: 'cdrom', label: 'CD/DVD (ISO)', type: 'file', remotePath: this.host.remote, filters: { 'Disk images': ['iso', 'img'] }, mediaDevice: 'cd0', group: 'Storage' },
			{ key: 'nic', label: 'Network adapter', type: 'select', required: true, options: NIC_OPTIONS, group: 'Network', description: restart },
			{ key: 'vga', label: 'Display adapter', type: 'select', required: true, readonly: arm, options: VGA_OPTIONS, group: 'Display', description: fixed('The display adapter') },
			{ key: 'serial', label: 'Serial console', type: 'checkbox', group: 'Display', description: restart },
			{
				key: 'firmware',
				label: 'Firmware',
				type: 'select',
				required: true,
				readonly: arm,
				options: this.qemu.archs[arch]?.firmwareCode ? FIRMWARE_OPTIONS : FIRMWARE_OPTIONS.filter((o) => o.value === 'bios' || o.value === def.firmware),
				group: 'Advanced',
				description: fixed('The firmware')
			},
			{ key: 'extraArgs', label: 'Extra QEMU arguments', type: 'text', group: 'Advanced', description: 'Appended to the command line, e.g. -device virtio-rng-pci' }
		];
		return {
			schema,
			values: {
				name: def.name,
				notes: def.notes,
				location: this.dir(def.id),
				arch: `${ARCH_LABEL[arch]}${this.native(arch) ? '' : ' (emulated)'}`,
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
		// What the architecture cannot have stays as it is (the form shows those fields read-only).
		Object.assign(def, normalizeHardware(guestArch(def), { firmware: def.firmware, diskBus: def.diskBus, nic: def.nic, vga: def.vga }));
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
		const context = { diskBus: guestArch(def) === 'aarch64' ? 'virtio' : def.diskBus };
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
					allocatedBytes: info?.['actual-size'],
					format: info?.format,
					bus
				};
			})
		);
		const cd = def.cdrom ? await this.imageInfo(def.cdrom) : undefined;
		return [
			...disks,
			{ id: 'cd0', kind: 'cdrom' as const, label: 'CD/DVD drive', path: def.cdrom, sizeBytes: cd?.['virtual-size'], format: cd?.format, bus: guestArch(def) === 'aarch64' ? 'scsi' : 'sata', readOnly: true, removable: true }
		];
	}

	private async imageInfo(file: string): Promise<ImageInfo | undefined> {
		try {
			const { stdout } = await this.host.exec(this.qemu.img, ['info', '--output=json', file], { timeout: 10_000 });
			return JSON.parse(stdout) as ImageInfo;
		} catch {
			return undefined;
		}
	}

	private async guestInterfaces(port: number): Promise<GuestInterface[] | undefined> {
		try {
			const agent = await GuestAgentClient.over(await this.host.connect(port), 1000);
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
			this.host.sampleProcess(runtime.pid),
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
		const guestMB = await this.guestMemoryMB(vmId, runtime).catch(() => undefined);
		return guestMB !== undefined
			? { timestamp: at, cpuUsage, memoryUsedMB: guestMB, memorySource: 'guest', memoryMB: def.memoryMB, disks }
			: { timestamp: at, cpuUsage, memoryUsedMB: process_?.rssMB, memorySource: 'host', memoryMB: def.memoryMB, disks };
	}

	/** Runs (pid) whose balloon was asked to report guest statistics. */
	private readonly balloonPolling = new Set<string>();

	/**
	 * Memory the guest uses (total minus available), from the balloon driver's statistics; undefined when
	 * the VM has no balloon (started before it existed, attached from outside) or the guest has no driver.
	 */
	private async guestMemoryMB(vmId: string, runtime: VmRuntime): Promise<number | undefined> {
		const client = await this.client(vmId, runtime);
		const path = '/machine/peripheral/balloon0';
		const key = `${vmId}:${runtime.pid}`;
		if (!this.balloonPolling.has(key)) {
			await client.execute('qom-set', { path, property: 'guest-stats-polling-interval', value: 2 });
			this.balloonPolling.add(key);
			return undefined;
		}
		const { stats, 'last-update': updated } = await client.execute<{ stats: Record<string, number>; 'last-update': number }>('qom-get', { path, property: 'guest-stats' });
		return balloonUsedMB(stats, updated);
	}

	// -----------------------------------------------------------------------------------------
	// Guest agent: commands and files
	// -----------------------------------------------------------------------------------------

	/** Runs `use` with a call into the guest agent of a running VM, over one connection. */
	private async withAgent<T>(vmId: string, use: (call: AgentCall) => Promise<T>): Promise<T> {
		const runtime = await this.runtime(vmId);
		if (!runtime) throw new ProviderError('Start the machine first.', 'invalid');
		if (!runtime.agentPort) throw new ProviderError('This machine has no guest agent channel: it was started outside VM Manager or by an older version. Restart it from here.', 'unsupported');
		let agent: GuestAgentClient;
		try {
			agent = await GuestAgentClient.over(await this.host.connect(runtime.agentPort), 2000);
		} catch (error) {
			throw explainAgentError(error);
		}
		try {
			return await use(<R,>(command: string, args?: Record<string, unknown>, timeoutMs?: number) => agent.execute<R>(command, args, timeoutMs ?? 10_000));
		} finally {
			agent.close();
		}
	}

	runInGuest(_nodeId: string, vmId: string, command: GuestCommand): Promise<GuestCommandResult> {
		return this.withAgent(vmId, (call) => runInGuest(call, command));
	}

	copyToGuest(_nodeId: string, vmId: string, localPath: string, guestPath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
		return this.withAgent(vmId, (call) => copyToGuest(call, localPath, guestPath, { onProgress }));
	}

	copyFromGuest(_nodeId: string, vmId: string, guestPath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
		return this.withAgent(vmId, (call) => copyFromGuest(call, guestPath, localPath, { onProgress }));
	}

	async ejectMedia(_nodeId: string, vmId: string, deviceId: string): Promise<void> {
		await this.changeMedia(vmId, deviceId, undefined);
	}

	async insertMedia(_nodeId: string, vmId: string, deviceId: string, imagePath: string): Promise<void> {
		if (!(await this.host.exists(imagePath))) throw new ProviderError(`Image not found: ${imagePath}`, 'invalid');
		await this.changeMedia(vmId, deviceId, imagePath);
	}

	// -----------------------------------------------------------------------------------------
	// Disks
	// -----------------------------------------------------------------------------------------

	/** The definition of a VM whose disks can be changed, and whether it runs. */
	private async diskVm(vmId: string, needsStopped: string | undefined): Promise<{ def: VmDefinition; runtime: VmRuntime | undefined }> {
		const def = await this.definition(vmId);
		if (def.origin === 'adopted') {
			throw new ProviderError('The disks of a VM that was attached from outside cannot be changed. Import it or recreate it here first.', 'unsupported');
		}
		const runtime = await this.runtime(vmId);
		if (runtime && needsStopped) throw new ProviderError(`Shut down "${def.name}" before ${needsStopped}.`, 'invalid');
		return { def, runtime };
	}

	private diskFile(def: VmDefinition, diskId: string): { index: number; file: string } {
		const index = diskIndex(diskId, def.disks.length);
		if (index === undefined) throw new ProviderError(`${def.name} has no disk ${diskId}`, 'notFound');
		return { index, file: def.disks[index]! };
	}

	private async img(args: string[], failure: string, timeout = 6 * 3600_000): Promise<void> {
		try {
			await this.host.exec(this.qemu.img, args, { timeout });
		} catch (error) {
			const detail = String((error as { stderr?: string }).stderr || (error as Error).message).trim().split('\n')[0];
			throw new ProviderError(`${failure}: ${detail}`, 'failed');
		}
	}

	async addDisk(_nodeId: string, vmId: string, disk: NewDisk): Promise<DiskDevice> {
		const { def } = await this.diskVm(vmId, 'adding a disk');
		const format = disk.format ?? 'qcow2';
		if (!Number.isFinite(disk.sizeBytes) || disk.sizeBytes < 1024 ** 2) throw new ProviderError('Give the disk at least 1 MB.', 'invalid');
		const bus = guestArch(def) === 'aarch64' ? 'virtio' : def.diskBus;
		const problem = addDiskProblem(def.disks.length, bus);
		if (problem) throw new ProviderError(problem, 'invalid');
		const snapshots = def.disks.length ? await this.listSnapshots(NODE_ID, vmId) : [];
		if (snapshots.length && format !== 'qcow2') throw new ProviderError('This machine has snapshots, which need qcow2 disks: add a qcow2 disk.', 'invalid');
		const dir = this.dir(vmId);
		// A file left behind by a removed disk keeps its name taken.
		const taken = [...def.disks];
		let file = newDiskFile(dir, taken, format, (...parts) => this.host.path.join(...parts));
		while (await this.host.exists(file)) {
			taken.push(file);
			file = newDiskFile(dir, taken, format, (...parts) => this.host.path.join(...parts));
		}
		await this.img(['create', '-f', format, file, String(Math.round(disk.sizeBytes))], 'Could not create the disk', 120_000);
		try {
			// The machine's snapshots cover every disk: the new one gets them too, empty, as it was when they were taken.
			for (const snapshot of snapshots) await this.snapshotImg(['-c', snapshot.name, file], `Could not prepare ${path.basename(file)} for snapshot "${snapshot.name}"`);
			def.disks = [...def.disks, file];
			await this.saveDefinition(def);
		} catch (error) {
			await this.host.rm(file).catch(() => undefined);
			throw error;
		}
		this.log.info(`Added ${file} (${disk.sizeBytes} bytes, ${format}) to ${def.name}`);
		this.changes.fire({ nodeId: NODE_ID, vmId });
		const index = def.disks.length - 1;
		return { id: `disk${index}`, kind: 'disk', label: `Hard disk ${index + 1}`, path: file, sizeBytes: disk.sizeBytes, format, bus };
	}

	async removeDisk(_nodeId: string, vmId: string, diskId: string, options: { deleteFile: boolean }): Promise<void> {
		const { def } = await this.diskVm(vmId, 'removing a disk');
		const { index, file } = this.diskFile(def, diskId);
		def.disks = def.disks.filter((_, i) => i !== index);
		await this.saveDefinition(def);
		if (options.deleteFile) await this.host.rm(file);
		this.log.info(`Removed ${file} from ${def.name}${options.deleteFile ? ' and deleted it' : ''}`);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	async resizeDisk(_nodeId: string, vmId: string, diskId: string, sizeBytes: number): Promise<void> {
		const { def, runtime } = await this.diskVm(vmId, undefined);
		const { index, file } = this.diskFile(def, diskId);
		const info = runtime ? undefined : await this.imageInfo(file);
		const current = runtime
			? (await (await this.client(vmId, runtime)).execute<QmpBlock[]>('query-block')).find((b) => b.device === `disk${index}`)?.inserted?.image?.['virtual-size']
			: info?.['virtual-size'];
		if (current === undefined) throw new ProviderError(`The size of ${path.basename(file)} cannot be read`, 'failed');
		if (!Number.isFinite(sizeBytes) || sizeBytes <= current) {
			throw new ProviderError('Disks can only grow: give a size larger than the current one.', 'invalid');
		}
		const size = Math.round(sizeBytes);
		if (runtime) {
			// The guest sees the new size at once; QEMU refuses to shrink.
			const client = await this.client(vmId, runtime);
			try {
				await client.execute('block_resize', { device: `disk${index}`, size });
			} catch (error) {
				throw new ProviderError(`Could not grow ${path.basename(file)}: ${(error as Error).message}`, 'failed');
			}
		} else {
			await this.img(['resize', '-f', info?.format ?? 'raw', file, String(size)], `Could not grow ${path.basename(file)}`, 10 * 60_000);
		}
		this.log.info(`Grew ${file} of ${def.name} to ${size} bytes${runtime ? ' (running)' : ''}`);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	async convertDisk(_nodeId: string, vmId: string, diskId: string, format: 'qcow2' | 'raw', progress?: (update: DiskProgress) => void): Promise<void> {
		const { def } = await this.diskVm(vmId, 'converting a disk');
		const { index, file } = this.diskFile(def, diskId);
		if (format !== 'qcow2' && format !== 'raw') throw new ProviderError(`Disks can be converted to qcow2 or raw, not ${String(format)}`, 'invalid');
		const snapshots = await this.listSnapshots(NODE_ID, vmId).catch(() => []);
		if (snapshots.length) {
			throw new ProviderError(`Converting a disk drops the snapshots inside it: delete the ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} of ${def.name} first.`, 'invalid');
		}
		const info = await this.imageInfo(file);
		if (!info?.format) throw new ProviderError(`${path.basename(file)} cannot be read`, 'failed');
		const { temp, final } = convertTarget(file, format);
		if (final !== file && (await this.host.exists(final))) throw new ProviderError(`${final} already exists`, 'invalid');
		progress?.({ message: `Writing ${path.basename(final)}…` });
		await this.host.rm(temp);
		try {
			await this.img(convertArgs(file, info.format, temp, format), `Could not convert ${path.basename(file)}`);
			await this.host.rename(temp, final);
		} catch (error) {
			await this.host.rm(temp).catch(() => undefined);
			throw error;
		}
		if (final !== file) {
			def.disks = def.disks.map((d, i) => (i === index ? final : d));
			await this.saveDefinition(def);
			await this.host.rm(file);
		}
		this.log.info(`Converted ${file} of ${def.name} to ${format}${final !== file ? ` (${final})` : ''}`);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	async exportDisk(_nodeId: string, vmId: string, diskId: string, targetPath: string, options: DiskExportOptions, progress?: (update: DiskProgress) => void): Promise<void> {
		// A running guest keeps writing: a copy taken now would be torn.
		const { def } = await this.diskVm(vmId, 'exporting a disk');
		const { file } = this.diskFile(def, diskId);
		if (targetPath === file) throw new ProviderError('Export to another file than the disk itself.', 'invalid');
		const info = await this.imageInfo(file);
		if (!info?.format) throw new ProviderError(`${path.basename(file)} cannot be read`, 'failed');
		let args: string[];
		try {
			args = exportArgs(file, info.format, targetPath, options);
		} catch (error) {
			throw new ProviderError((error as Error).message, 'invalid');
		}
		progress?.({ message: `Writing ${path.basename(targetPath)}…` });
		await this.img(args, `Could not export ${path.basename(file)}`);
		this.log.info(`Exported ${file} of ${def.name} to ${targetPath} (${options.format}${options.compress ? ', compressed' : ''})`);
	}

	async cloneVm(_nodeId: string, vmId: string, name: string): Promise<VmInfo> {
		name = name.trim();
		if (!VM_NAME.test(name)) throw new ProviderError('Use 1–64 letters, digits, spaces or . _ ( ) - for the name', 'invalid');
		if ((await this.definitions()).some((d) => d.name.toLowerCase() === name.toLowerCase())) {
			throw new ProviderError(`A virtual machine named "${name}" already exists`, 'invalid');
		}
		const source = await this.definition(vmId);
		if (source.origin === 'adopted') {
			throw new ProviderError('A VM that was attached from outside cannot be cloned. Import it or recreate it here first.', 'unsupported');
		}
		// A running guest keeps writing: a copy taken now would be torn.
		if (await this.runtime(vmId)) throw new ProviderError(`Shut down "${source.name}" before cloning it`, 'invalid');
		for (const disk of source.disks) {
			if (!(await this.host.exists(disk))) throw new ProviderError(`The disk ${disk} of "${source.name}" was not found`, 'notFound');
		}
		const id = randomUUID();
		const dir = this.dir(id);
		await this.host.mkdir(dir);
		try {
			// `convert` writes a compact qcow2 and leaves the source's internal snapshots behind.
			const disks: string[] = [];
			for (let index = 0; index < source.disks.length; index++) {
				const target = this.host.path.join(dir, `disk${index}.qcow2`);
				try {
					await this.host.exec(this.qemu.img, ['convert', '-O', 'qcow2', source.disks[index]!, target], { timeout: 60 * 60_000 });
				} catch (error) {
					const detail = String((error as { stderr?: string }).stderr || (error as Error).message).trim().split('\n')[0];
					throw new ProviderError(`Could not copy ${path.basename(source.disks[index]!)}: ${detail}`, 'failed');
				}
				disks.push(target);
			}
			// The UEFI variables (boot entries) travel with the machine.
			const vars = this.host.path.join(this.dir(vmId), 'efivars.fd');
			if (source.firmware === 'uefi' && (await this.host.exists(vars))) await this.host.copyFile(vars, this.host.path.join(dir, 'efivars.fd'));
			const def = cloneDefinition(source, { id, name, disks, mac: randomMac(), now: Date.now() });
			// A machine from cloud-init gets its own seed: same instance id would make the guest skip first-boot
			// setup (host name, SSH host keys), a fresh one runs it. The machine-id inside the disk is still shared.
			const ci = source.cloudInit;
			const ownSeed = source.cdrom && source.cdrom === this.host.path.join(this.dir(vmId), 'seed.iso');
			if (ci && ownSeed && ci.installAgent !== undefined) {
				const seed = this.host.path.join(dir, 'seed.iso');
				await this.writeSeed(seed, id, { ...ci, hostname: hostnameFor(name) });
				def.cdrom = seed;
				def.cloudInit = { ...ci, hostname: hostnameFor(name) };
			}
			if (def.firmware === 'uefi') await this.ensureVars(def);
			await this.saveDefinition(def);
			this.log.info(`Cloned ${source.name} to ${name} in ${dir}`);
			this.changes.fire({ nodeId: NODE_ID, vmId: id });
			return { id, name, state: 'stopped', cpus: def.cpus, memoryMB: def.memoryMB };
		} catch (error) {
			await this.host.rm(dir, { recursive: true });
			throw error;
		}
	}

	// -----------------------------------------------------------------------------------------
	// Snapshots: qcow2 internal snapshots, disk state only (see snapshots.ts)
	// -----------------------------------------------------------------------------------------

	/** Snapshots need every disk to be qcow2 and the VM to be one we manage. Returns the disk files. */
	private async snapshotDisks(def: VmDefinition): Promise<string[]> {
		if (def.origin === 'adopted') {
			throw new ProviderError('Snapshots are not available for a VM that was attached from outside. Import it or recreate it here.', 'unsupported');
		}
		if (!def.disks.length) throw new ProviderError('The VM has no disk to snapshot', 'unsupported');
		for (const disk of def.disks) {
			const info = await this.snapshotInfo(disk);
			if (info?.format !== 'qcow2') {
				throw new ProviderError(`Snapshots need qcow2 disks, but ${path.basename(disk)} is ${info?.format ?? 'unreadable'}. Convert it first.`, 'unsupported');
			}
		}
		return def.disks;
	}

	/** `-U` reads an image that a running VM holds open. */
	private async snapshotInfo(file: string): Promise<{ format?: string; snapshots?: QemuSnapshotInfo[] } | undefined> {
		try {
			const { stdout } = await this.host.exec(this.qemu.img, ['info', '-U', '--output=json', file], { timeout: 15_000 });
			return JSON.parse(stdout) as { format?: string; snapshots?: QemuSnapshotInfo[] };
		} catch {
			return undefined;
		}
	}

	private async snapshotImg(args: string[], what: string): Promise<void> {
		try {
			await this.host.exec(this.qemu.img, ['snapshot', ...args], { timeout: 120_000 });
		} catch (error) {
			const detail = String((error as { stderr?: string }).stderr || (error as Error).message).trim().split('\n')[0];
			throw new ProviderError(`${what}: ${detail}`, 'failed');
		}
	}

	async listSnapshots(_nodeId: string, vmId: string): Promise<Snapshot[]> {
		const def = await this.definition(vmId);
		if (def.origin === 'adopted') return [];
		const runtime = await this.runtime(vmId);
		if (runtime) {
			const blocks = await (await this.client(vmId, runtime)).execute<QmpSnapshotBlock[]>('query-block');
			return commonSnapshots(qmpSnapshots(blocks, def.disks.map((_, index) => `disk${index}`)));
		}
		const infos = await Promise.all(def.disks.map((disk) => this.snapshotInfo(disk)));
		return commonSnapshots(infos.map((info) => info?.snapshots ?? []));
	}

	async createSnapshot(nodeId: string, vmId: string, name: string): Promise<Snapshot> {
		const problem = snapshotNameProblem(name);
		if (problem) throw new ProviderError(problem, 'invalid');
		const def = await this.definition(vmId);
		const disks = await this.snapshotDisks(def);
		if ((await this.listSnapshots(nodeId, vmId)).some((snap) => snap.name.toLowerCase() === name.toLowerCase())) {
			throw new ProviderError(`A snapshot named "${name}" already exists`, 'invalid');
		}
		const runtime = await this.runtime(vmId);
		const done: number[] = [];
		try {
			if (runtime) {
				// A running guest: the disks are captured as they are, like pulling the plug (crash-consistent).
				const client = await this.client(vmId, runtime);
				for (let index = 0; index < disks.length; index++) {
					await client.execute('blockdev-snapshot-internal-sync', { device: `disk${index}`, name });
					done.push(index);
				}
			} else {
				for (let index = 0; index < disks.length; index++) {
					await this.snapshotImg(['-c', name, disks[index]!], `Could not snapshot ${path.basename(disks[index]!)}`);
					done.push(index);
				}
			}
		} catch (error) {
			// All disks or none: a snapshot that exists on only some of them could not be reverted.
			await this.removeSnapshot(vmId, runtime, disks, name, done).catch(() => undefined);
			throw error instanceof ProviderError ? error : new ProviderError(`Could not take the snapshot: ${(error as Error).message}`, 'failed');
		}
		this.log.info(`Snapshot "${name}" of ${def.name}${runtime ? ' (running, disk state only)' : ''}`);
		this.changes.fire({ nodeId: NODE_ID, vmId });
		return { id: name, name, createdAt: Date.now(), includesMemory: false };
	}

	async revertSnapshot(nodeId: string, vmId: string, snapshotId: string): Promise<void> {
		const def = await this.definition(vmId);
		const disks = await this.snapshotDisks(def);
		if (await this.runtime(vmId)) {
			throw new ProviderError('Power the VM off before reverting: the snapshot holds disk state only, so a running guest cannot continue from it.', 'invalid');
		}
		if (!(await this.listSnapshots(nodeId, vmId)).some((snap) => snap.id === snapshotId)) {
			throw new ProviderError(`Snapshot "${snapshotId}" was not found on every disk`, 'notFound');
		}
		for (const disk of disks) await this.snapshotImg(['-a', snapshotId, disk], `Could not revert ${path.basename(disk)}`);
		this.log.info(`Reverted ${def.name} to "${snapshotId}"`);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	async deleteSnapshot(nodeId: string, vmId: string, snapshotId: string): Promise<void> {
		const def = await this.definition(vmId);
		const disks = await this.snapshotDisks(def);
		if (!(await this.listSnapshots(nodeId, vmId)).some((snap) => snap.id === snapshotId)) {
			throw new ProviderError(`Snapshot "${snapshotId}" was not found`, 'notFound');
		}
		const runtime = await this.runtime(vmId);
		await this.removeSnapshot(vmId, runtime, disks, snapshotId, disks.map((_, index) => index));
		this.log.info(`Deleted snapshot "${snapshotId}" of ${def.name}`);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	/** Removes a snapshot from the listed disks, a running VM through QMP and a stopped one through qemu-img. */
	private async removeSnapshot(vmId: string, runtime: VmRuntime | undefined, disks: string[], name: string, indexes: number[]): Promise<void> {
		if (runtime) {
			const client = await this.client(vmId, runtime);
			for (const index of indexes) await client.execute('blockdev-snapshot-delete-internal-sync', { device: `disk${index}`, name });
		} else {
			for (const index of indexes) await this.snapshotImg(['-d', name, disks[index]!], `Could not delete the snapshot from ${path.basename(disks[index]!)}`);
		}
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
			await this.host.rm(dir, { recursive: true });
			this.log.info(`Detached from ${def.name} (still running)`);
			return;
		}
		if (await this.runtime(vmId)) await this.forceStop(vmId);
		if (options.deleteDisks) {
			await this.host.rm(dir, { recursive: true });
		} else {
			for (const file of ['vm.json', 'runtime.json', 'efivars.fd', 'qemu.log']) {
				await this.host.rm(this.host.path.join(dir, file));
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
			const agent = await GuestAgentClient.over(await this.host.connect(runtime.agentPort), 2000);
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
			if (!(await this.host.isAlive(pid))) return true;
			await sleep(200);
		}
		return !(await this.host.isAlive(pid));
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
		if (def.template) throw new ProviderError(`${def.name} is a template. Create a machine from it, or convert it back to a VM first.`, 'invalid');
		for (const disk of def.disks) {
			if (!(await this.host.exists(disk))) throw new ProviderError(`Disk not found: ${disk}`, 'invalid');
		}
		if (def.cdrom && !(await this.host.exists(def.cdrom))) throw new ProviderError(`ISO not found: ${def.cdrom}`, 'invalid');
		for (const address of def.pciDevices ?? []) {
			// QEMU only opens devices that vfio-pci owns; say so instead of showing its terse failure.
			if (this.host.platform !== 'linux') throw new ProviderError(`${def.name} has PCI passthrough devices, which need a Linux host.`, 'unsupported');
			if (pciDriver(address) !== 'vfio-pci') {
				throw new ProviderError(`PCI device ${address} is not bound to vfio-pci (it was rebound or the host restarted). Detach it in the VM details and attach it again.`, 'unavailable');
			}
		}
		// A port that something else (another program, a VM of another window) took after our probe:
		// QEMU says so and exits; try again with different ports.
		const rejected = new Set<number>();
		for (let attempt = 1; ; attempt++) {
			const avoid = new Set([...(await this.portsInUse()), ...rejected]);
			const runtime: VmRuntime = {
				pid: 0,
				qmpPort: await this.host.freePort(undefined, undefined, avoid),
				vncPort: await this.host.freePort(5900, 5999, avoid),
				serialPort: def.serial ? await this.host.freePort(undefined, undefined, avoid) : undefined,
				agentPort: await this.host.freePort(undefined, undefined, avoid),
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
			accelerators: this.acceleratorsOf(guestArch(def)),
			firmwareCode: this.install(guestArch(def)).firmwareCode,
			firmwareVars: def.firmware === 'uefi' ? await this.ensureVars(def) : undefined
		});
		const logPath = this.host.path.join(dir, 'qemu.log');
		const system = this.install(guestArch(def)).system;
		this.log.info(`Starting ${def.name}: ${system} ${args.join(' ')}`);
		runtime.pid = await this.host.spawnDetached(system, args, { cwd: dir, logFile: logPath });
		await this.host.writeFile(this.host.path.join(dir, 'runtime.json'), JSON.stringify(runtime, null, 2));

		// Wait for QMP; report QEMU's own error output when it dies early.
		const deadline = Date.now() + (this.host.remote ? 30_000 : 15_000);
		while (Date.now() < deadline) {
			if (!(await this.host.isAlive(runtime.pid))) {
				await this.clearRuntime(def.id);
				const output = (await this.host.readFile(logPath).catch(() => '')).trim();
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
			await this.host.signal(runtime.pid, 'SIGTERM');
			if (!(await this.waitStopped(runtime.pid, 3000))) {
				await this.host.signal(runtime.pid, 'SIGKILL');
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
		const vnc = kind === 'vnc';
		const port = vnc ? runtime.vncPort : runtime.serialPort;
		const socketPath = vnc ? runtime.vncSocket : runtime.serialSocket;
		if (!port && !socketPath) {
			if (vnc) throw new ProviderError('This VM has no VNC server VM Manager can reach (it may use a native window).', 'unavailable');
			throw new ProviderError(
				def.origin === 'adopted'
					? `${def.name} has no serial port on a socket (e.g. -serial telnet:127.0.0.1:4555,server=on,wait=off), so its serial console cannot be opened.`
					: 'The serial console is disabled for this VM. Enable it in the settings and restart the VM.',
				'unavailable'
			);
		}
		const host = (vnc ? runtime.vncHost : runtime.serialHost) ?? '127.0.0.1';
		const socket = await (socketPath ? this.host.connectSocket(socketPath) : this.host.connect(port!, host)).catch((error: Error) => {
			throw new ProviderError(`Could not open the ${vnc ? 'display' : 'serial console'} of ${def.name} at ${socketPath ?? `${host}:${port}`}: ${error.message}`, 'unavailable');
		});
		const stream = !vnc && runtime.serialTelnet ? telnetStream(socket) : socket;
		return { stream, dispose: () => stream.destroy() };
	}

	// -----------------------------------------------------------------------------------------
	// Device passthrough (USB hot-plug, Linux VFIO)
	// -----------------------------------------------------------------------------------------

	async getPassthrough(_nodeId: string, vmId: string): Promise<PassthroughInfo> {
		const def = await this.definition(vmId);
		const runtime = await this.runtime(vmId);
		const devices: PassthroughDevice[] = [];
		const info: PassthroughInfo = { usb: { supported: true }, pci: { supported: true, experimental: true }, devices };

		// USB
		try {
			const attached = new Set<string>();
			if (runtime && hasControlChannel(runtime)) {
				const list = await (await this.client(vmId, runtime)).execute<Array<{ name: string }>>('qom-list', { path: '/machine/peripheral' }).catch(() => []);
				for (const item of list) {
					const parsed = item.name.startsWith(USB_ID_PREFIX) ? parseUsbDeviceId(item.name) : undefined;
					if (parsed) attached.add(usbKey(parsed));
				}
			}
			for (const usb of await listUsbHost()) {
				devices.push({
					id: `usb:${usbKey(usb)}`,
					kind: 'usb',
					label: usb.name,
					address: usbKey(usb),
					attached: attached.has(usbKey(usb)),
					unavailable: runtime ? undefined : 'Start the VM first: USB devices are hot-plugged'
				});
			}
		} catch (error) {
			info.usb = { supported: false, reason: (error as Error).message };
		}

		// PCI
		if (process.platform !== 'linux') {
			info.pci = { supported: false, reason: `PCI passthrough (VFIO) needs a Linux host; this is ${process.platform === 'darwin' ? 'macOS' : process.platform}.` };
		} else {
			try {
				const all = await listPciHost();
				const iommu = iommuEnabled();
				if (!iommu) info.pci = { supported: false, experimental: true, reason: 'The IOMMU is not enabled (boot with intel_iommu=on or amd_iommu=on and enable VT-d / AMD-Vi in the firmware).' };
				else {
					const mine = new Set(def.pciDevices ?? []);
					for (const pci of all.filter((d) => !isBridge(d))) {
						const verdict = assessVfio(pci, all, iommu);
						devices.push({
							id: `pci:${pci.address}`,
							kind: 'pci',
							label: pciClassName(pci.classCode),
							address: pci.address,
							detail: `${pci.vendorId.toString(16).padStart(4, '0')}:${pci.deviceId.toString(16).padStart(4, '0')}${pci.driver ? ` · driver ${pci.driver}` : ''}${pci.iommuGroup !== undefined ? ` · IOMMU group ${pci.iommuGroup}` : ''}`,
							attached: mine.has(pci.address),
							unavailable: verdict.eligible ? (runtime && !mine.has(pci.address) ? 'Stop the VM first: PCI devices are attached at start' : undefined) : verdict.warnings[0]
						});
					}
				}
			} catch (error) {
				info.pci = { supported: false, experimental: true, reason: (error as Error).message };
			}
		}
		return info;
	}

	async planPassthrough(_nodeId: string, vmId: string, deviceId: string, action: 'attach' | 'detach'): Promise<PassthroughPlan> {
		const def = await this.definition(vmId);
		const runtime = await this.runtime(vmId);
		if (deviceId.startsWith('usb:')) {
			const usb = this.parseUsbId(deviceId);
			if (action === 'attach' && !runtime) throw new ProviderError('Start the VM first: USB devices are hot-plugged.', 'unavailable');
			// QEMU would accept an absent device and wait for it to show up; a stale selection is more likely a mistake.
			if (action === 'attach' && !(await listUsbHost().then((list) => list.some((d) => usbKey(d) === usbKey(usb)), () => true))) {
				throw new ProviderError(`USB device ${usbKey(usb)} is not connected to the host any more. Refresh the list.`, 'notFound');
			}
			return {
				title: `${action === 'attach' ? 'Attach' : 'Detach'} USB device ${usbKey(usb)}`,
				steps: action === 'attach' ? [`device_add usb-host vendorid=0x${usbKey(usb).slice(0, 4)} productid=0x${usbKey(usb).slice(5)}`] : [`device_del ${usbDeviceId(usb)}`],
				warnings:
					action === 'attach'
						? ['The host loses the device while the VM has it (a keyboard or mouse stops working on the host).', ...(process.platform === 'darwin' ? ['macOS may refuse to hand over devices that a driver or the system has claimed.'] : [])]
						: [],
				needsConfirmation: false
			};
		}
		const address = this.parsePciId(deviceId);
		if (process.platform !== 'linux') throw new ProviderError('PCI passthrough (VFIO) needs a Linux host.', 'unsupported');
		if (runtime) throw new ProviderError('Stop the VM first: PCI devices are attached at start.', 'unavailable');
		const all = await listPciHost();
		const device = all.find((d) => d.address === address);
		if (!device) throw new ProviderError(`PCI device ${address} not found`, 'notFound');
		if (action === 'attach') {
			const verdict = assessVfio(device, all, iommuEnabled());
			if (!verdict.eligible) throw new ProviderError(verdict.warnings[0] ?? 'This device cannot be passed through', 'unavailable');
			const uid = this.uid();
			return {
				title: `Attach PCI device ${address} to ${def.name}`,
				steps: [
					'Run as root (asks for authentication through polkit):',
					...bindScript(address, device.iommuGroup!, uid).map((line) => `    ${line}`),
					`Add the device to ${def.name}: QEMU opens it with -device vfio-pci,host=${address} at every start.`,
					'The device stays on vfio-pci after the VM stops until you detach it here, which returns it to its host driver.'
				],
				warnings: verdict.warnings,
				needsConfirmation: true,
				experimental: true
			};
		}
		return {
			title: `Detach PCI device ${address} from ${def.name}`,
			steps: ['Remove the device from the VM.', 'Run as root (asks for authentication through polkit):', ...releaseScript(address).map((line) => `    ${line}`)],
			warnings: [`The host driver${device.driver && device.driver !== 'vfio-pci' ? '' : ' (if any)'} takes the device back; a GPU used by the host may reset its display.`],
			needsConfirmation: true,
			experimental: true
		};
	}

	async changePassthrough(nodeId: string, vmId: string, deviceId: string, action: 'attach' | 'detach', options: { confirmed: boolean }): Promise<void> {
		const plan = await this.planPassthrough(nodeId, vmId, deviceId, action);
		if (plan.needsConfirmation && !options.confirmed) throw new ProviderError('This change needs the explicit confirmation of the user.', 'permission');
		const def = await this.definition(vmId);
		if (deviceId.startsWith('usb:')) {
			const usb = this.parseUsbId(deviceId);
			const runtime = await this.runtime(vmId);
			if (!runtime || !hasControlChannel(runtime)) throw new ProviderError(`${def.name} is not running or has no control socket`, 'unavailable');
			const client = await this.client(vmId, runtime);
			try {
				if (action === 'attach') await client.execute('device_add', usbAddArguments(usb));
				else await client.execute('device_del', { id: usbDeviceId(usb) });
			} catch (error) {
				throw new ProviderError(`${action === 'attach' ? 'Could not attach' : 'Could not detach'} ${usbKey(usb)}: ${(error as Error).message}`, 'failed');
			}
			this.changes.fire({ nodeId: NODE_ID, vmId });
			return;
		}
		const address = this.parsePciId(deviceId);
		if (action === 'attach') {
			const device = (await listPciHost()).find((d) => d.address === address)!;
			await runPrivileged(bindScript(address, device.iommuGroup!, this.uid()));
			def.pciDevices = [...new Set([...(def.pciDevices ?? []), address])];
		} else {
			def.pciDevices = (def.pciDevices ?? []).filter((a) => a !== address);
			await this.saveDefinition(def);
			await runPrivileged(releaseScript(address));
		}
		await this.saveDefinition(def);
		this.log.info(`${action === 'attach' ? 'Attached' : 'Detached'} PCI device ${address} ${action === 'attach' ? 'to' : 'from'} ${def.name}`);
		this.changes.fire({ nodeId: NODE_ID, vmId });
	}

	private parseUsbId(deviceId: string): { vendorId: number; productId: number } {
		const match = /^usb:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(deviceId);
		if (!match) throw new ProviderError(`Invalid USB device: ${deviceId}`, 'invalid');
		return { vendorId: parseInt(match[1]!, 16), productId: parseInt(match[2]!, 16) };
	}

	private parsePciId(deviceId: string): string {
		const address = deviceId.startsWith('pci:') ? deviceId.slice(4) : '';
		if (!PCI_ADDRESS.test(address)) throw new ProviderError(`Invalid PCI device: ${deviceId}`, 'invalid');
		return address;
	}

	private uid(): number {
		const uid = process.getuid?.();
		if (uid === undefined) throw new ProviderError('Cannot determine the current user', 'unsupported');
		return uid;
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
		return findExternalVms(await this.host.listProcesses(), await this.knownPids());
	}

	async scanExternalVms(): Promise<ExternalVmInfo[]> {
		return (await this.scanRunning()).map((vm) => ({
			id: String(vm.pid),
			name: vm.name,
			detail: [
				`pid ${vm.pid}`,
				`${vm.cpus} CPU`,
				vm.memoryMB >= 1024 ? `${Math.round((vm.memoryMB / 1024) * 10) / 10} GB` : `${vm.memoryMB} MB`,
				vm.disks.length ? path.basename(vm.disks[0]!) : undefined,
				vm.vncPort || vm.vncSocket ? 'display' : undefined,
				vm.serial ? 'serial' : undefined
			]
				.filter(Boolean)
				.join(' · '),
			controllable: !!vm.qmp,
			hint: vm.qmp ? undefined : 'No control socket (-qmp): it can only be observed and powered off. Restart it from VM Manager for full control.'
		}));
	}

	async adoptExternalVm(_nodeId: string, externalId: string): Promise<{ vm: VmInfo; warning?: string }> {
		const found = (await this.scanRunning()).find((vm) => String(vm.pid) === externalId);
		if (!found) throw new ProviderError('That QEMU process is gone, or is already managed. Scan again.', 'notFound');
		const id = randomUUID();
		const dir = this.dir(id);
		await this.host.mkdir(dir);
		try {
			const def: VmDefinition = {
				id,
				name: await this.uniqueName(found.name),
				cpus: found.cpus,
				memoryMB: found.memoryMB,
				cpuModel: 'unknown',
				arch: archFromName(found.binary),
				firmware: 'bios',
				disks: found.disks,
				diskBus: 'sata',
				cdrom: found.cdrom,
				nic: 'none',
				vga: 'std',
				serial: !!found.serial,
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
				vncHost: found.vncHost,
				vncSocket: found.vncSocket,
				serialPort: found.serial?.port,
				serialHost: found.serial?.host,
				serialSocket: found.serial?.socket,
				serialTelnet: found.serial?.telnet,
				startedAt: (await this.host.processStartedAt(found.pid)) ?? Date.now(),
				external: true
			};
			// Runtime first: a definition without one is an adopted VM that is gone, and gets cleaned up.
			await this.host.writeFile(this.host.path.join(dir, 'runtime.json'), JSON.stringify(runtime, null, 2));
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
					await this.host.writeFile(this.host.path.join(dir, 'runtime.json'), JSON.stringify({ ...runtime, qmpPort: 0, qmpSocket: undefined }, null, 2));
				}
			}
			this.log.info(`Attached to pid ${found.pid} as ${def.name}${warning ? `: ${warning}` : ''}`);
			this.changes.fire({ nodeId: NODE_ID, vmId: id });
			const consoles: ConsoleKind[] = [];
			if (runtime.vncPort || runtime.vncSocket) consoles.push('vnc');
			if (def.serial) consoles.push('serial');
			return { vm: { id, name: def.name, state: 'running', cpus: def.cpus, memoryMB: def.memoryMB, origin: 'adopted', controllable: !warning, consoles }, warning };
		} catch (error) {
			await this.host.rm(dir, { recursive: true });
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
				const arch = candidate.arch === undefined ? (this.installedArchs().find((a) => this.native(a)) ?? 'x86_64') : archFromName(candidate.arch);
				if (!arch) throw new ProviderError(`${candidate.name}: the architecture "${candidate.arch}" is not supported (x86-64 and ARM64 only).`, 'unsupported');
				const hardware = normalizeHardware(arch, { firmware: candidate.uefi ? 'uefi' : 'bios', diskBus: 'sata', nic: 'e1000', vga: 'std' });
				const uefi = hardware.firmware === 'uefi' && !!this.install(arch).firmwareCode;
				const def: VmDefinition = {
					id,
					name: await this.uniqueName(candidate.name),
					arch,
					cpus: Math.max(1, candidate.cpus ?? 2),
					memoryMB: Math.max(128, candidate.memoryMB ?? 2048),
					cpuModel: 'max',
					firmware: uefi ? 'uefi' : 'bios',
					disks,
					diskBus: hardware.diskBus,
					cdrom: candidate.cdrom,
					nic: hardware.nic,
					mac: randomMac(),
					vga: hardware.vga,
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
		this.host.dispose();
	}
}

/** An adopted VM may have no monitor at all (see `ExternalVm.qmp`). */
function hasControlChannel(runtime: VmRuntime): boolean {
	return !!(runtime.qmpSocket || runtime.qmpPort);
}

function randomMac(): string {
	const byte = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
	return `52:54:00:${byte()}:${byte()}:${byte()}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const freePort = freeLocalPort;
