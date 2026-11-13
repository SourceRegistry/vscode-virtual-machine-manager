/**
 * Message protocol between the extension host and the webviews. Types only — imported by both
 * sides so the RPC stays typed end to end.
 */
import type {
	Capabilities,
	FieldSchema,
	FieldValues,
	NodeInfo,
	PortForward,
	Snapshot,
	PowerAction,
	PreviewFrame,
	VmConfig,
	PassthroughInfo,
	VmDetails,
	VmInfo,
	VmStats
} from '@vmm/sdk';

/** Console actions run in the page: `refresh` re-fits the serial terminal and asks the guest to redraw. */
export type ConsoleCommand = 'ctrlAltDel' | 'toggleScaling' | 'refresh';

export type ViewKind ='overview' | 'vmSettings' | 'vmDashboard' | 'console.vnc' | 'console.serial' | 'console.preview' | 'console.rdp';

export interface VmRef {
	clusterId: string;
	nodeId: string;
	vmId: string;
}

export type ClusterStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'missingProvider';

/** A VM as the UI shows it: while `operation` runs, `state` is its transitional state. */
export interface VmSnapshot extends VmInfo {
	operation?: PowerAction;
	/** Marked by the user in VM Manager (not on the hypervisor). */
	favorite?: boolean;
	/** The user's groups it is in. */
	groups?: string[];
}

export interface NodeSnapshot extends NodeInfo {
	vms: VmSnapshot[];
}

export interface ClusterSnapshot {
	id: string;
	name: string;
	providerId: string;
	providerName: string;
	/** `ssh me@lab` when the machines run on another computer. */
	remote?: string;
	status: ClusterStatus;
	error?: string;
	capabilities?: Capabilities;
	nodes: NodeSnapshot[];
}

/** Data the host embeds into the page so the webview can render before the first round-trip. */
export interface BootData {
	view: ViewKind;
	title: string;
	ref?: VmRef;
	vmName?: string;
	settings?: {
		scaleViewport: boolean;
		/** Serial console: answer `CSI 18 t` with the terminal's size in characters. */
		reportWindowSize?: boolean;
	};
	/** RDP console: where the IronRDP WebAssembly module is served from. */
	rdp?: { wasmUrl: string };
}

/** Everything the in-editor RDP client needs to start a session through the host's gateway. */
export interface RdpStartConfig {
	username: string;
	domain: string;
	password: string;
	/** `host:port` the client reports in its RDCleanPath request. */
	destination: string;
	/** Per-session secret the gateway expects as `proxy_auth`. */
	authToken: string;
	vmConnect?: { vmId: string; mode: 'basic' | 'enhanced' };
	/** The gateway authenticates with the user's Windows logon; the client skips its own CredSSP. */
	singleSignOn?: boolean;
}

/** IronRDP error kinds (iron-remote-desktop `IronErrorKind`). */
export const RdpErrorKind = {
	General: 0,
	WrongPassword: 1,
	LogonFailure: 2,
	AccessDenied: 3,
	RDCleanPath: 4,
	ProxyConnect: 5,
	NegotiationFailure: 6
} as const;

/** Commands the overview is allowed to run on the host (allow-listed there). */
export type OverviewCommand =
	| 'vmm.start'
	| 'vmm.shutdown'
	| 'vmm.reboot'
	| 'vmm.stop'
	| 'vmm.connectGraphical'
	| 'vmm.connectSerial'
	| 'vmm.openExternal'
	| 'vmm.editVm'
	| 'vmm.openVmDashboard'
	| 'vmm.ejectMedia'
	| 'vmm.changeMedia'
	| 'vmm.manageDisks'
	| 'vmm.cloneVm'
	| 'vmm.convertToTemplate'
	| 'vmm.convertToVm'
	| 'vmm.createFromTemplate'
	| 'vmm.connectSsh'
	| 'vmm.takeSnapshot'
	| 'vmm.revertSnapshot'
	| 'vmm.deleteSnapshot'
	| 'vmm.deleteVm'
	| 'vmm.detachVm'
	| 'vmm.createVm'
	| 'vmm.attachRunningVm'
	| 'vmm.importFromFolder'
	| 'vmm.addCluster'
	| 'vmm.editCluster'
	| 'vmm.reconnectCluster'
	| 'vmm.refresh';

/** A multi-VM action: how many machines it was done to (or started on) and how many were left out. */
export interface BulkOutcome {
	done: number;
	skipped: number;
}

export interface RpcMethods {
	// overview
	snapshot: { params: void; result: ClusterSnapshot[] };
	/**
	 * Starts `action` on every listed VM it applies to, in the background (a shutdown can take
	 * minutes). Failures are reported on the host side in one message.
	 */
	bulkPower: { params: { action: PowerAction; refs: VmRef[] }; result: BulkOutcome };
	/** Deletes the listed VMs after one confirmation on the host side (attached VMs are skipped). */
	bulkDelete: { params: { refs: VmRef[] }; result: BulkOutcome };
	/** One CPU/memory/disk sample per listed running VM; empty while the overview is hidden. */
	vmStats: { params: { refs: VmRef[] }; result: Array<{ ref: VmRef; stats: VmStats }> };
	runCommand: {
		/** `diskId`: the disk a dashboard row's action is about (`vmm.manageDisks`). */
		params: { command: OverviewCommand; ref?: VmRef; clusterId?: string; nodeId?: string; diskId?: string };
		result: void;
	};
	// vm dashboard
	getDashboard: { params: void; result: { vm?: VmInfo; capabilities?: Capabilities } };
	getDetails: { params: void; result: VmDetails | undefined };
	/** `undefined` while the panel is hidden (no work done) or the provider has no statistics. */
	getStats: { params: void; result: VmStats | undefined };
	/** Host devices (USB, PCI) that can be given to this VM. Slow on some hosts: not part of `getDetails`. */
	getPassthrough: { params: void; result: PassthroughInfo | undefined };
	/**
	 * Attaches or detaches a host device. The host side asks the user to confirm the provider's plan
	 * when it changes the host (VFIO rebinds, shared groups); `changed` is false when they declined.
	 */
	changePassthrough: { params: { deviceId: string; action: 'attach' | 'detach' }; result: { changed: boolean } };
	/** Snapshots of this VM, oldest first. */
	listSnapshots: { params: void; result: Snapshot[] };
	/** `name` is optional: the host asks for one. `undefined` when the user cancelled or it failed (already reported). */
	takeSnapshot: { params: { name?: string }; result: Snapshot | undefined };
	/** The host asks the user to confirm, and powers the VM off first when the hypervisor needs it. `false` when declined or failed. */
	revertSnapshot: { params: { snapshotId: string }; result: boolean };
	deleteSnapshot: { params: { snapshotId: string }; result: boolean };
	addForward: { params: { forward: PortForward }; result: void };
	removeForward: { params: { forward: PortForward }; result: void };
	/** Copies the ssh command or opens the forward in the browser. */
	forwardAction: { params: { action: 'copySsh' | 'open'; forward: PortForward }; result: void };
	// vm settings
	getConfig: { params: void; result: VmConfig & { vm?: VmInfo } };
	save: { params: { values: FieldValues }; result: { message: string } };
	ejectMedia: { params: { deviceId: string }; result: void };
	browse: {
		params: { directory: boolean; title: string; current?: string; filters?: Record<string, string[]> };
		result: string | undefined;
	};
	// console
	reconnect: { params: void; result: void };
	power: { params: { action: PowerAction }; result: void };
	openExternal: { params: void; result: void };
}

export type RpcMethod = keyof RpcMethods;

export type WebviewToHost =
	| { kind: 'ready' }
	| { kind: 'request'; id: number; method: RpcMethod; params?: unknown }
	| { kind: 'console.input'; data: Uint8Array }
	/** RDP client opened / closed its (relayed) gateway socket. */
	| { kind: 'console.socket'; action: 'open' | 'close' }
	/** Diagnostics from a console view, written to the VM Manager output channel. */
	| { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
	/** Shown to the user as a notification (e.g. characters that could not be typed). */
	| { kind: 'notify'; level: 'info' | 'warn'; message: string }
	/** RDP session failed (errorKind: `RdpErrorKind`) or ended. */
	| { kind: 'rdp.ended'; errorKind?: number; message?: string };

export type ConsoleStatus = 'connecting' | 'open' | 'closed' | 'error';

export type HostToWebview =
	| { kind: 'response'; id: number; ok: true; result: unknown }
	| { kind: 'response'; id: number; ok: false; error: string }
	| { kind: 'event'; name: 'snapshot'; payload: ClusterSnapshot[] }
	| { kind: 'event'; name: 'vm'; payload: VmInfo | undefined }
	| { kind: 'console.status'; status: ConsoleStatus; message?: string }
	| { kind: 'console.data'; data: Uint8Array }
	| { kind: 'console.credentials'; password: string }
	| { kind: 'console.command'; command: ConsoleCommand }
	/** Type `text` as key presses (consoles without a clipboard channel). */
	| { kind: 'console.type'; text: string }
	| { kind: 'rdp.start'; config: RdpStartConfig }
	| { kind: 'preview.frame'; frame: PreviewFrame };

export type { FieldSchema, FieldValues };
