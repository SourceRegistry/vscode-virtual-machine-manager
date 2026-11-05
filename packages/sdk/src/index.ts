/**
 * VM Manager provider SDK.
 *
 * A provider extension (e.g. "VM Manager – Hyper-V") depends on the core extension through
 * `extensionDependencies`, reads the core API from `vscode.extensions.getExtension(CORE_EXTENSION_ID).exports`
 * and calls `registerProvider()`. The core owns all UI, credential storage and console transport;
 * the provider only talks to its hypervisor.
 *
 * This module has no runtime dependency on `vscode` so it can be unit tested and bundled anywhere.
 */
import type { Duplex } from 'node:stream';

export const VMM_API_VERSION = 1;
export const CORE_EXTENSION_ID = 'sourceregistry.vm-manager';
/** `package.json` key a provider extension uses to announce the providers it contributes. */
export const PROVIDER_CONTRIBUTION_KEY = 'vmManager.providers';

// ---------------------------------------------------------------------------------------------
// Primitives (structurally compatible with vscode.Disposable / vscode.Event)
// ---------------------------------------------------------------------------------------------

export interface Disposable {
	dispose(): unknown;
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string | Error): void;
	debug(message: string): void;
}

// ---------------------------------------------------------------------------------------------
// Field schemas: providers describe forms once, the core renders them as native multi-step
// input (QuickPick / InputBox) or as a webview form.
// ---------------------------------------------------------------------------------------------

export type FieldType =
	| 'text'
	| 'password'
	| 'number'
	| 'select'
	| 'checkbox'
	| 'file'
	| 'directory'
	| 'textarea';

export type FieldValue = string | number | boolean | undefined;
export type FieldValues = Record<string, FieldValue>;

export interface FieldOption {
	value: string;
	label: string;
	description?: string;
}

export interface FieldSchema {
	key: string;
	label: string;
	type: FieldType;
	description?: string;
	placeholder?: string;
	required?: boolean;
	/** Stored in VS Code SecretStorage (OS keychain) instead of global state. */
	secret?: boolean;
	default?: FieldValue;
	options?: FieldOption[];
	min?: number;
	max?: number;
	/** Display unit for numbers, e.g. `MB`, `GB`, `cores`. */
	unit?: string;
	/** File dialog filters for `file` fields, e.g. `{ 'Disk images': ['iso', 'img'] }`. */
	filters?: Record<string, string[]>;
	readonly?: boolean;
	/** Section heading used by the webview settings editor. */
	group?: string;
	/**
	 * `file` fields only: the id of the CD/DVD drive (`DiskDevice.id`) this field mounts. The settings
	 * editor then offers an eject button while the field holds an image.
	 */
	mediaDevice?: string;
	/** Hide in the quick (native) create flow; still shown in the full settings editor. */
	advanced?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

export type PowerAction = 'start' | 'shutdown' | 'reboot' | 'stop' | 'reset';
export type ConsoleKind = 'vnc' | 'serial' | 'rdp';
export type VmState = 'running' | 'stopped' | 'paused' | 'saved' | 'starting' | 'stopping' | 'unknown';
export type NodeStatus = 'online' | 'offline' | 'unknown';

export interface Capabilities {
	create: boolean;
	edit: boolean;
	delete: boolean;
	power: PowerAction[];
	/** Console kinds the provider can stream. Individual VMs may narrow this with `VmInfo.consoles`. */
	consoles: ConsoleKind[];
	/** Low frame-rate screenshot preview (used when no VNC is available, e.g. Hyper-V). */
	preview: boolean;
	/** Can open the hypervisor's own viewer (e.g. vmconnect.exe). */
	external: boolean;
	/** Implements `ejectMedia` / `insertMedia` for CD/DVD drives. */
	media?: boolean;
	/** Implements `getVmDetails` (hardware inventory). */
	details?: boolean;
	/** Implements `getVmStats` (live usage counters). */
	stats?: boolean;
	/** Implements `addPortForward` / `removePortForward`. */
	forwards?: boolean;
}

export interface NodeInfo {
	id: string;
	name: string;
	status: NodeStatus;
	cpus?: number;
	/** 0..1 */
	cpuUsage?: number;
	memoryMB?: number;
	memoryUsedMB?: number;
	description?: string;
	/** Labelled facts shown on the node card, e.g. `{ label: 'Version', value: 'QEMU 11.1.2' }`. */
	facts?: Array<{ label: string; value: string }>;
}

export interface VmInfo {
	id: string;
	name: string;
	state: VmState;
	cpus?: number;
	memoryMB?: number;
	uptimeSeconds?: number;
	ipAddresses?: string[];
	os?: string;
	description?: string;
	/** Narrows `Capabilities.consoles` for this VM (e.g. serial port not configured). */
	consoles?: ConsoleKind[];
	/** A CD/DVD drive of this VM holds media (an ISO): the core offers a quick eject. */
	mediaInserted?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Hardware inventory and live statistics (optional provider features)
// ---------------------------------------------------------------------------------------------

export interface DiskDevice {
	/** Stable id within the VM; the handle for `ejectMedia` / `insertMedia`. */
	id: string;
	kind: 'disk' | 'cdrom';
	label: string;
	/** Backing file. For a CD/DVD drive: the inserted image, undefined when the drive is empty. */
	path?: string;
	sizeBytes?: number;
	/** e.g. `qcow2`, `vhdx`. */
	format?: string;
	/** e.g. `sata`, `virtio`, `scsi`, `ide`. */
	bus?: string;
	readOnly?: boolean;
	/** Media can be swapped (CD/DVD drives). */
	removable?: boolean;
}

export interface NicDevice {
	id: string;
	label: string;
	model?: string;
	mac?: string;
	/** Attachment, e.g. `user` networking, a bridge or a Hyper-V switch name. */
	network?: string;
	ipAddresses?: string[];
	connected?: boolean;
}

/** Another device the guest sees: PCI/PCIe (including passthrough), USB, serial… */
export interface HostDevice {
	id: string;
	kind: 'pci' | 'usb' | 'other';
	label: string;
	/** e.g. PCI `00:02.0` or `vendor:product`. */
	address?: string;
	description?: string;
}

export interface PortForward {
	protocol: 'tcp' | 'udp';
	hostAddress?: string;
	hostPort: number;
	guestPort: number;
}

export interface VmDetails {
	disks: DiskDevice[];
	nics: NicDevice[];
	devices: HostDevice[];
	forwards: PortForward[];
}

/** Cumulative I/O counters of one disk since the VM started. */
export interface DiskStats {
	/** Matches `DiskDevice.id`. */
	id: string;
	readBytes: number;
	writeBytes: number;
	readOps: number;
	writeOps: number;
	/** Total time spent servicing reads/writes/flushes; (delta time / delta ops) is the average latency. */
	readTimeNs?: number;
	writeTimeNs?: number;
	flushOps?: number;
	flushTimeNs?: number;
}

/**
 * One usage sample. Counters are cumulative so the consumer derives rates from two samples;
 * `timestamp` (ms since the epoch) is when the provider took it.
 */
export interface VmStats {
	timestamp: number;
	/** 0..1 of the CPU allotted to the VM. */
	cpuUsage?: number;
	memoryUsedMB?: number;
	memoryMB?: number;
	disks?: DiskStats[];
	network?: { rxBytes: number; txBytes: number };
}

export interface ClusterConfig {
	id: string;
	name: string;
	providerId: string;
	/** Non-secret connection values. */
	config: FieldValues;
}

/** Secret connection values, resolved from SecretStorage by the core. */
export type SecretBag = Readonly<Record<string, string | undefined>>;

export interface ProviderContext {
	/** Directory reserved for this provider + cluster (created on demand by the provider). */
	storagePath: string;
	log: Logger;
}

export interface ChangeEvent {
	nodeId?: string;
	vmId?: string;
}

export interface VmConfig {
	schema: FieldSchema[];
	values: FieldValues;
}

export interface DeleteOptions {
	deleteDisks: boolean;
}

/**
 * A live console byte stream. For `vnc` the stream carries raw RFB protocol bytes, for `serial`
 * raw terminal bytes and for `rdp` the raw TCP connection to the RDP endpoint (the core does the
 * pre-connection blob, TLS and relaying; the in-editor client does CredSSP and RDP).
 */
export interface ConsoleStream {
	stream: Duplex;
	dispose(): void;
}

/** Where and how the core's RDP client connects for an `rdp` console. */
export interface RdpTarget {
	/** Host name of the RDP server, used as the CredSSP service principal (e.g. the Hyper-V host). */
	serverName: string;
	/**
	 * Hyper-V VMConnect routing: the core sends this VM id as a pre-connection blob before TLS.
	 * `basic` is the VM's own console (works for every guest, including firmware screens);
	 * `enhanced` asks the guest for an Enhanced Session (needs guest support).
	 */
	vmConnect?: { vmId: string; mode: 'basic' | 'enhanced' };
	/** Suggested user name for the credential prompt, e.g. `DESKTOP-ALEX\alex`. */
	defaultUsername?: string;
	/** Explains whose credentials are asked for, e.g. "your Windows account on DESKTOP-ALEX". */
	credentialsHint?: string;
	/** Advice shown when the server rejects the sign-in (account formats, policies…). */
	signInHelp?: string;
	/**
	 * Single sign-on with the identity VS Code runs as (e.g. Windows SSPI "Negotiate" with the
	 * logon token). When present the core authenticates the RDP connection (CredSSP) itself and
	 * asks for no password; it falls back to a password prompt if this fails.
	 */
	currentUser?: {
		/** e.g. `DESKTOP-ALEX\\alex`, shown in the console status. */
		readonly displayName: string;
		createContext(targetName: string): Promise<SecurityContext>;
	};
}

/**
 * A client-side GSS/SSPI security context (Negotiate/Kerberos/NTLM), as needed for CredSSP:
 * token exchange, then message encryption with the negotiated session key.
 */
export interface SecurityContext {
	/** Advances the handshake with the server's token (empty on the first call). */
	step(input: Uint8Array): Promise<{ token: Uint8Array; complete: boolean }>;
	/** Seals `data` (SSPI EncryptMessage); the result is `trailer ‖ ciphertext`. */
	encrypt(data: Uint8Array, sequence: number): Promise<Uint8Array>;
	/** Unseals `trailer ‖ ciphertext` from the server (SSPI DecryptMessage). */
	decrypt(data: Uint8Array, sequence: number): Promise<Uint8Array>;
	dispose(): void;
}

export interface PreviewFrame {
	width: number;
	height: number;
	/** `rgb565` little-endian (Hyper-V thumbnails) or `rgba`. */
	format: 'rgb565' | 'rgba';
	data: Uint8Array;
}

export interface ClusterConnection extends Disposable {
	readonly capabilities: Capabilities;
	listNodes(): Promise<NodeInfo[]>;
	listVms(nodeId: string): Promise<VmInfo[]>;
	getCreateSchema(nodeId: string): Promise<FieldSchema[]>;
	createVm(nodeId: string, values: FieldValues): Promise<VmInfo>;
	getVmConfig(nodeId: string, vmId: string): Promise<VmConfig>;
	updateVm(nodeId: string, vmId: string, values: FieldValues): Promise<void>;
	deleteVm(nodeId: string, vmId: string, options: DeleteOptions): Promise<void>;
	power(nodeId: string, vmId: string, action: PowerAction): Promise<void>;
	openConsole(nodeId: string, vmId: string, kind: ConsoleKind): Promise<ConsoleStream>;
	/** Required when `capabilities.consoles` includes `rdp`. Called before `openConsole(…, 'rdp')`. */
	getRdpTarget?(nodeId: string, vmId: string): Promise<RdpTarget>;
	openPreview?(nodeId: string, vmId: string, signal: AbortSignal): AsyncIterable<PreviewFrame>;
	openExternal?(nodeId: string, vmId: string): Promise<void>;
	/** Hardware inventory of a VM (disks, CD drives, NICs, PCI/USB devices, port forwards). */
	getVmDetails?(nodeId: string, vmId: string): Promise<VmDetails>;
	/** One live usage sample; the core calls it repeatedly while a dashboard is open. */
	getVmStats?(nodeId: string, vmId: string): Promise<VmStats>;
	/** Empties a CD/DVD drive (`DiskDevice.id`). Works on running VMs; forces open a locked tray. */
	ejectMedia?(nodeId: string, vmId: string, deviceId: string): Promise<void>;
	/** Inserts an image into a CD/DVD drive, replacing the current one. */
	insertMedia?(nodeId: string, vmId: string, deviceId: string, imagePath: string): Promise<void>;
	/** Forwards a host port to a guest port. Works on running VMs and is remembered for the next start. */
	addPortForward?(nodeId: string, vmId: string, forward: PortForward): Promise<void>;
	removePortForward?(nodeId: string, vmId: string, forward: PortForward): Promise<void>;
	/** Fire to make the core refresh immediately. Without it the core polls. */
	readonly onDidChange?: Event<ChangeEvent>;
}

export interface HypervisorProvider {
	/** Stable id, also used in `package.json` `contributes["vmManager.providers"]`. */
	readonly id: string;
	readonly displayName: string;
	/** Codicon id for tree items, e.g. `server-environment`. */
	readonly icon?: string;
	readonly connectionSchema: FieldSchema[];
	defaultClusterName?(): string;
	testConnection?(cluster: ClusterConfig, secrets: SecretBag, context: ProviderContext): Promise<void>;
	connect(cluster: ClusterConfig, secrets: SecretBag, context: ProviderContext): Promise<ClusterConnection>;
}

export interface VmManagerApi {
	readonly apiVersion: number;
	registerProvider(provider: HypervisorProvider): Disposable;
}

/** Shape of an entry in `contributes["vmManager.providers"]` of a provider extension. */
export interface ProviderContribution {
	id: string;
	displayName: string;
	description?: string;
}

// ---------------------------------------------------------------------------------------------
// Helpers shared by providers and core
// ---------------------------------------------------------------------------------------------

export class ProviderError extends Error {
	/**
	 * `timeout`: a graceful request (shutdown, reboot) was sent but the guest did not act on it.
	 * The core then offers to power the VM off.
	 */
	constructor(
		message: string,
		readonly code: 'notFound' | 'unsupported' | 'permission' | 'unavailable' | 'invalid' | 'timeout' | 'failed' = 'failed'
	) {
		super(message);
		this.name = 'ProviderError';
	}
}

export function fieldDefaults(schema: FieldSchema[]): FieldValues {
	const values: FieldValues = {};
	for (const field of schema) if (field.default !== undefined) values[field.key] = field.default;
	return values;
}

/** Coerce raw (string) form values to the types declared by the schema. */
export function coerceValues(schema: FieldSchema[], raw: Record<string, unknown>): FieldValues {
	const values: FieldValues = {};
	for (const field of schema) {
		const value = raw[field.key];
		if (value === undefined || value === null) continue;
		switch (field.type) {
			case 'number': {
				if (value === '') break;
				const n = typeof value === 'number' ? value : Number(value);
				if (!Number.isNaN(n)) values[field.key] = n;
				break;
			}
			case 'checkbox':
				values[field.key] = value === true || value === 'true' || value === 'on' || value === '1';
				break;
			default:
				values[field.key] = String(value);
		}
	}
	return values;
}

/** Returns an error message for the first invalid field, or undefined. */
export function validateValue(field: FieldSchema, value: FieldValue): string | undefined {
	const empty = value === undefined || value === '';
	if (empty) return field.required ? `${field.label} is required` : undefined;
	if (field.type === 'number') {
		const n = Number(value);
		if (Number.isNaN(n)) return `${field.label} must be a number`;
		if (field.min !== undefined && n < field.min) return `${field.label} must be at least ${field.min}`;
		if (field.max !== undefined && n > field.max) return `${field.label} must be at most ${field.max}`;
	}
	if (field.type === 'select' && field.options && !field.options.some((o) => o.value === String(value))) {
		return `${field.label} has an unknown value`;
	}
	return undefined;
}

export function validateValues(schema: FieldSchema[], values: FieldValues): { key: string; message: string } | undefined {
	for (const field of schema) {
		const message = validateValue(field, values[field.key]);
		if (message) return { key: field.key, message };
	}
	return undefined;
}

export function formatMemory(mb: number | undefined): string {
	if (mb === undefined) return '–';
	return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

export function formatUptime(seconds: number | undefined): string {
	if (!seconds) return '–';
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	return `${m}m`;
}
