/**
 * Message protocol between the extension host and the webviews. Types only — imported by both
 * sides so the RPC stays typed end to end.
 */
import type {
	Capabilities,
	FieldSchema,
	FieldValues,
	NodeInfo,
	PowerAction,
	PreviewFrame,
	VmConfig,
	VmInfo
} from '@vmm/sdk';

export type ViewKind = 'overview' | 'vmSettings' | 'console.vnc' | 'console.serial' | 'console.preview';

export interface VmRef {
	clusterId: string;
	nodeId: string;
	vmId: string;
}

export type ClusterStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'missingProvider';

export interface NodeSnapshot extends NodeInfo {
	vms: VmInfo[];
}

export interface ClusterSnapshot {
	id: string;
	name: string;
	providerId: string;
	providerName: string;
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
	settings?: { scaleViewport: boolean };
}

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
	| 'vmm.deleteVm'
	| 'vmm.createVm'
	| 'vmm.addCluster'
	| 'vmm.editCluster'
	| 'vmm.reconnectCluster'
	| 'vmm.refresh';

export interface RpcMethods {
	// overview
	snapshot: { params: void; result: ClusterSnapshot[] };
	runCommand: {
		params: { command: OverviewCommand; ref?: VmRef; clusterId?: string; nodeId?: string };
		result: void;
	};
	// vm settings
	getConfig: { params: void; result: VmConfig & { vm?: VmInfo } };
	save: { params: { values: FieldValues }; result: { message: string } };
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
	| { kind: 'console.input'; data: Uint8Array };

export type ConsoleStatus = 'connecting' | 'open' | 'closed' | 'error';

export type HostToWebview =
	| { kind: 'response'; id: number; ok: true; result: unknown }
	| { kind: 'response'; id: number; ok: false; error: string }
	| { kind: 'event'; name: 'snapshot'; payload: ClusterSnapshot[] }
	| { kind: 'event'; name: 'vm'; payload: VmInfo | undefined }
	| { kind: 'console.status'; status: ConsoleStatus; message?: string }
	| { kind: 'console.data'; data: Uint8Array }
	| { kind: 'console.command'; command: 'ctrlAltDel' | 'toggleScaling' }
	| { kind: 'preview.frame'; frame: PreviewFrame };

export type { FieldSchema, FieldValues };
