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

/**
 * Version of the API between the core and provider extensions. Bump it whenever `VmManagerApi` or
 * `HypervisorProvider` gains something a provider may rely on (providers built against an older
 * core cannot use it) or loses/changes something (see `VMM_MIN_API_VERSION`).
 */
export const VMM_API_VERSION = 1;
/**
 * Oldest provider API version this core still supports. Raise it only for a breaking change; until
 * then providers built against any version in `VMM_MIN_API_VERSION..VMM_API_VERSION` keep working.
 */
export const VMM_MIN_API_VERSION = 1;
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
	| 'textarea'
	/** A host to reach with ssh: picked from the user's ssh config, or typed as `user@host`. */
	| 'sshHost';

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
	/**
	 * `file` / `directory` fields: the path is on another computer (an SSH host), so a file dialog here would
	 * pick the wrong thing and is not offered. A string names another field: remote while that one has a value;
	 * `{ key, equals }`: remote while that field has that value.
	 */
	remotePath?: boolean | string | { key: string; equals: FieldValue };
	/** Section heading used by the webview settings editor. */
	group?: string;
	/**
	 * `file` fields only: the id of the CD/DVD drive (`DiskDevice.id`) this field mounts. The settings
	 * editor then offers an eject button while the field holds an image.
	 */
	mediaDevice?: string;
	/** Hide in the quick (native) create flow; still shown in the full settings editor. */
	advanced?: boolean;
	/** Only ask for this field while another field has one of the given values (e.g. a sign-in method). */
	showWhen?: { key: string; equals: FieldValue | FieldValue[]; /** Assumed when the other field has no value yet (older saved configs). */ default?: FieldValue };
}

/** Whether a path field points at another computer, given the current values (no file dialog then). */
export function isRemotePath(field: FieldSchema, values: FieldValues): boolean {
	if (typeof field.remotePath === 'string') return !!values[field.remotePath];
	if (field.remotePath && typeof field.remotePath === 'object') return values[field.remotePath.key] === field.remotePath.equals;
	return !!field.remotePath;
}

/** Whether a field applies given the current values. Hidden fields are neither asked nor validated. */
export function isFieldVisible(field: FieldSchema, values: FieldValues, schema?: FieldSchema[], depth = 0): boolean {
	if (!field.showWhen) return true;
	// With the schema at hand a field also needs the field that controls it to apply (a chain of conditions).
	const controller = schema?.find((f) => f.key === field.showWhen!.key);
	if (controller && depth < 8 && !isFieldVisible(controller, values, schema, depth + 1)) return false;
	const current = values[field.showWhen.key] ?? field.showWhen.default;
	const wanted = field.showWhen.equals;
	return Array.isArray(wanted) ? wanted.includes(current) : wanted === current;
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

export type PowerAction = 'start' | 'shutdown' | 'reboot' | 'stop' | 'reset';
export type ConsoleKind = 'vnc' | 'serial' | 'rdp';
export type VmState = 'running' | 'stopped' | 'paused' | 'saved' | 'starting' | 'stopping' | 'unknown';
export type NodeStatus = 'online' | 'offline' | 'unknown';

export interface Capabilities {
	/** The connection holds a sign-in session the user can end (`ClusterConnection.signOut`). */
	signOut?: boolean;
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
	/** Implements `listSnapshots` / `createSnapshot` / `revertSnapshot` / `deleteSnapshot`. */
	snapshots?: boolean;
	/** `revertSnapshot` needs the VM stopped: the core asks the user to power it off first. */
	snapshotRevertNeedsStopped?: boolean;
	/** Implements `cloneVm`. */
	clone?: boolean;
	/** `cloneVm` needs the VM stopped: the core tells the user to shut it down first instead of trying. */
	cloneNeedsStopped?: boolean;
	/** Implements `getVmDetails` (hardware inventory). */
	details?: boolean;
	/** Implements `getVmStats` (live usage counters). */
	stats?: boolean;
	/** Image and disk paths are on the host (an SSH host), not on this computer: ask for them as text, no file dialog. */
	remotePaths?: boolean;
	/** Implements `addPortForward` / `removePortForward`. */
	forwards?: boolean;
	/** Implements `getPassthrough` / `planPassthrough` / `changePassthrough`. */
	passthrough?: boolean;
	/** Implements `scanExternalVms` / `adoptExternalVm`. */
	adopt?: boolean;
	/** Implements `scanImportFolder` / `importFromFolder`. */
	importFolder?: boolean;
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
	/** MAC addresses of the VM's network adapters; searchable in the VM picker. */
	macAddresses?: string[];
	os?: string;
	description?: string;
	/** A number or short id people know the VM by (the Proxmox VMID). Shown beside the name in the tree. */
	displayId?: string;
	/** Narrows `Capabilities.consoles` for this VM (e.g. serial port not configured). */
	consoles?: ConsoleKind[];
	/** A CD/DVD drive of this VM holds media (an ISO): the core offers a quick eject. */
	mediaInserted?: boolean;
	/**
	 * Where the VM came from when it was not created here: `adopted` = a process started outside the
	 * extension that it attached to, `imported` = built from existing disk images or definitions.
	 */
	origin?: 'adopted' | 'imported';
	/** `false` for an adopted VM without a control channel: it can only be observed and powered off. */
	controllable?: boolean;
}

/** A hypervisor process found on the host that was not started by the extension. */
export interface ExternalVmInfo {
	/** Handle for `adoptExternalVm` (a process id for QEMU). */
	id: string;
	name: string;
	/** One line: what it has (CPUs, memory, disks). */
	detail: string;
	/** The extension can fully control it (a control socket is reachable). */
	controllable: boolean;
	/** Why it is observe-only / what to do about it. */
	hint?: string;
}

/** A VM that can be created from files already on disk. */
export interface ImportCandidate {
	id: string;
	name: string;
	/** e.g. `libvirt definition`, `disk image`. */
	source: string;
	detail: string;
}

export interface ImportOptions {
	/** Copy the disk files into the VM's own folder instead of using them where they are. */
	copy: boolean;
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

/** A saved state of a VM's disks that it can be returned to. */
export interface Snapshot {
	/** Stable handle for `revertSnapshot` / `deleteSnapshot`. */
	id: string;
	name: string;
	/** Milliseconds since the epoch. */
	createdAt?: number;
	/** Disk space the snapshot holds, when the hypervisor reports it. */
	sizeBytes?: number;
	/** The snapshot also holds memory and CPU state, so reverting resumes a running guest. Otherwise it is disk-only. */
	includesMemory?: boolean;
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
	/** The host can connect to `ipAddresses` directly. `false` behind NAT (QEMU user networking), where only forwarded ports work. Absent: assume yes. */
	reachable?: boolean;
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

/** A host device that can be handed to a guest. */
export interface PassthroughDevice {
	/** Stable handle for `planPassthrough` / `changePassthrough`, e.g. `usb:046d:c52b` or `pci:0000:01:00.0`. */
	id: string;
	kind: 'usb' | 'pci';
	label: string;
	/** USB `vendor:product`, PCI address. */
	address: string;
	detail?: string;
	/** Currently given to this VM. */
	attached: boolean;
	/** The provider will not hand it over; says why. */
	unavailable?: string;
}

export interface PassthroughSupport {
	supported: boolean;
	/** Why not, or what is needed. */
	reason?: string;
	experimental?: boolean;
}

export interface PassthroughInfo {
	usb: PassthroughSupport;
	pci: PassthroughSupport;
	devices: PassthroughDevice[];
}

/** What attaching or detaching a device will do to the host, for an explicit confirmation. */
export interface PassthroughPlan {
	title: string;
	/** Changes on the host, in order; privileged commands are listed verbatim. */
	steps: string[];
	warnings: string[];
	/** The user must confirm before `changePassthrough` runs (host changes, shared groups). */
	needsConfirmation: boolean;
	experimental?: boolean;
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
	uptimeSeconds?: number;
	/** Aggregate cumulative disk byte counters when per-device I/O is unavailable. */
	diskIo?: { readBytes: number; writeBytes: number };
	/** Reported guest storage usage; may be unavailable for QEMU guests. */
	diskUsage?: { usedBytes?: number; capacityBytes?: number };
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
	/**
	 * `false` for a connection the extension starts by itself (opening the view, a refresh): the provider
	 * must not prompt or open a browser, and throws `ProviderError(…, 'authRequired')` when it cannot
	 * connect without. `true` when the user asked to connect. Absent = interactive.
	 */
	interactive?: boolean;
	/** Aborted when the user cancels the connection attempt (e.g. a sign-in waiting on a browser). */
	signal?: AbortSignal;
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
	/** Ephemeral VNC proxy credentials; never persisted by the core. */
	credentials?: { password: string };
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
	/** Ends the sign-in session and forgets whatever was stored for it. The core then drops the connection. */
	signOut?(): Promise<void>;
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
	/**
	 * Makes an independent copy of a VM under a new name (`createVm`'s name rules apply): its own disks, its own
	 * identity (MAC address), nothing shared with the original. Snapshots, port forwards and passed-through
	 * host devices are not carried over. Can take minutes for a large disk.
	 */
	cloneVm?(nodeId: string, vmId: string, name: string): Promise<VmInfo>;
	/** Snapshots of a VM, oldest first. */
	listSnapshots?(nodeId: string, vmId: string): Promise<Snapshot[]>;
	/**
	 * Saves the current state under `name` (unique within the VM). A provider that can only snapshot
	 * disks takes a crash-consistent copy when the VM runs and says so through `Snapshot.includesMemory`.
	 */
	createSnapshot?(nodeId: string, vmId: string, name: string): Promise<Snapshot>;
	/** Returns the VM to a snapshot, discarding everything changed since. See `Capabilities.snapshotRevertNeedsStopped`. */
	revertSnapshot?(nodeId: string, vmId: string, snapshotId: string): Promise<void>;
	deleteSnapshot?(nodeId: string, vmId: string, snapshotId: string): Promise<void>;
	/** Host devices that can be given to the VM, and what is supported on this host. */
	getPassthrough?(nodeId: string, vmId: string): Promise<PassthroughInfo>;
	planPassthrough?(nodeId: string, vmId: string, deviceId: string, action: 'attach' | 'detach'): Promise<PassthroughPlan>;
	/** `confirmed` must be true when the plan said `needsConfirmation`; the provider rejects otherwise. */
	changePassthrough?(nodeId: string, vmId: string, deviceId: string, action: 'attach' | 'detach', options: { confirmed: boolean }): Promise<void>;
	/** Forwards a host port to a guest port. Works on running VMs and is remembered for the next start. */
	addPortForward?(nodeId: string, vmId: string, forward: PortForward): Promise<void>;
	removePortForward?(nodeId: string, vmId: string, forward: PortForward): Promise<void>;
	/** Lists running VMs that were not started by this extension. */
	scanExternalVms?(nodeId: string): Promise<ExternalVmInfo[]>;
	/** Attaches to one of them. `warning` explains a limited attachment (no control channel). */
	adoptExternalVm?(nodeId: string, externalId: string): Promise<{ vm: VmInfo; warning?: string }>;
	/** Finds VMs in a folder: disk images, definitions of other tools. */
	scanImportFolder?(nodeId: string, folder: string): Promise<ImportCandidate[]>;
	importFromFolder?(nodeId: string, folder: string, candidateIds: string[], options: ImportOptions): Promise<VmInfo[]>;
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
	/**
	 * Where the machines of this cluster run when that is another computer reached over ssh or the like (`ssh me@lab`),
	 * from the saved configuration alone, so it can be shown while the cluster is still connecting. `undefined` for
	 * a provider that is always remote (a server API) or a cluster that is local.
	 */
	remoteLabel?(cluster: ClusterConfig): string | undefined;
	testConnection?(cluster: ClusterConfig, secrets: SecretBag, context: ProviderContext): Promise<void>;
	connect(cluster: ClusterConfig, secrets: SecretBag, context: ProviderContext): Promise<ClusterConnection>;
}

/** Core-owned browser callback UI; providers retain their authorization and token exchange logic. */
export interface BrowserLoginOptions<T> {
	providerName: string;
	/** Optional PNG data URI (for example the provider extension's Marketplace icon). */
	providerIcon?: string;
	port: number;
	signal?: AbortSignal;
	getAuthorizationUrl(redirectUrl: string): Promise<string>;
	/** Validate/exchange the response before the core displays success. Never log codes or tokens. */
	exchange(response: { code: string; state: string; redirectUrl: string }): Promise<T>;
}

export interface VmManagerApi {
	/** Newest API version this core implements. */
	readonly apiVersion: number;
	/** Oldest provider API version this core still supports; cores without it require an exact match. */
	readonly minApiVersion?: number;
	registerProvider(provider: HypervisorProvider): Disposable;
	/** Available in core versions that provide shared browser sign-in. */
	browserLogin?<T>(options: BrowserLoginOptions<T>): Promise<T>;
}

/** Shape of an entry in `contributes["vmManager.providers"]` of a provider extension. */
export interface ProviderContribution {
	id: string;
	displayName: string;
	description?: string;
	/** `VMM_API_VERSION` the provider was built against. Lets the core refuse an incompatible provider before activating it. */
	apiVersion?: number;
}

export interface ApiCompatibility {
	ok: boolean;
	/** Which side must be updated; set when `ok` is false. */
	update?: 'core' | 'provider';
	/** User-facing explanation; set when `ok` is false. */
	message?: string;
}

/**
 * Decides whether a provider built against `providerApi` can run on a core offering
 * `minApiVersion..apiVersion`. A provider newer than the core may use API the core lacks; a provider
 * older than the core's minimum relies on API the core removed.
 */
export function checkApiCompatibility(
	name: string,
	providerApi: number | undefined,
	core: { apiVersion: number; minApiVersion?: number }
): ApiCompatibility {
	if (providerApi === undefined) return { ok: true }; // not declared: nothing to compare
	const min = core.minApiVersion ?? core.apiVersion;
	if (providerApi > core.apiVersion) {
		return { ok: false, update: 'core', message: `${name} needs a newer VM Manager (it uses API version ${providerApi}, VM Manager provides ${core.apiVersion}). Update VM Manager.` };
	}
	if (providerApi < min) {
		return { ok: false, update: 'provider', message: `${name} is too old for this VM Manager (it uses API version ${providerApi}, VM Manager supports ${min} to ${core.apiVersion}). Update ${name}.` };
	}
	return { ok: true };
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
		readonly code: 'notFound' | 'unsupported' | 'permission' | 'unavailable' | 'invalid' | 'timeout' | 'authRequired' | 'failed' = 'failed'
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
		if (!isFieldVisible(field, values, schema)) continue;
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
