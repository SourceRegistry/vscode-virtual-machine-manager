import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ClusterConnection, PowerAction, VmInfo } from '@vmm/sdk';
import type { ClusterSnapshot, ClusterStatus, NodeSnapshot, VmRef } from '../../shared/protocol';
import type { ClusterStore, StoredCluster } from './ClusterStore';
import type { ProviderRegistry } from '../registry/ProviderRegistry';
import { errorMessage, log, scopedLogger } from '../util/log';

export interface ClusterRuntime {
	cluster: StoredCluster;
	status: ClusterStatus;
	error?: string;
	connection?: ClusterConnection;
	nodes: NodeSnapshot[];
	loaded: boolean;
	connecting?: Promise<ClusterConnection>;
	refreshing?: Promise<void>;
	changeSubscription?: vscode.Disposable;
}

export interface VmLocation {
	ref: VmRef;
	vm: VmInfo;
	cluster: ClusterRuntime;
	node: NodeSnapshot;
}

/**
 * Owns the live connections to all configured clusters, caches their nodes and VMs and keeps
 * them fresh (polling while visible, or provider change events).
 */
export class ConnectionManager implements vscode.Disposable {
	private readonly runtimes = new Map<string, ClusterRuntime>();
	private readonly emitter = new vscode.EventEmitter<string | undefined>();
	/** Fires with the cluster id that changed, or undefined for structural changes. */
	readonly onDidChange = this.emitter.event;
	private readonly visibility = new Set<string>();
	private timer: NodeJS.Timeout | undefined;
	private readonly disposables: vscode.Disposable[] = [this.emitter];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: ClusterStore,
		private readonly registry: ProviderRegistry
	) {
		this.syncFromStore();
		this.disposables.push(
			store.onDidChange(() => this.syncFromStore()),
			registry.onDidChange(() => this.retryMissingProviders()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('vmm.refreshInterval')) this.updateTimer(true);
			})
		);
	}

	// -----------------------------------------------------------------------------------------
	// Queries
	// -----------------------------------------------------------------------------------------

	clusters(): ClusterRuntime[] {
		return this.store
			.all()
			.map((c) => this.runtimes.get(c.id))
			.filter((r): r is ClusterRuntime => !!r);
	}

	cluster(id: string): ClusterRuntime | undefined {
		return this.runtimes.get(id);
	}

	node(clusterId: string, nodeId: string): NodeSnapshot | undefined {
		return this.runtimes.get(clusterId)?.nodes.find((n) => n.id === nodeId);
	}

	findVm(ref: VmRef): VmLocation | undefined {
		const cluster = this.runtimes.get(ref.clusterId);
		const node = cluster?.nodes.find((n) => n.id === ref.nodeId);
		const vm = node?.vms.find((v) => v.id === ref.vmId);
		return cluster && node && vm ? { ref, vm, cluster, node } : undefined;
	}

	allVms(): VmLocation[] {
		const result: VmLocation[] = [];
		for (const cluster of this.clusters()) {
			for (const node of cluster.nodes) {
				for (const vm of node.vms) {
					result.push({ ref: { clusterId: cluster.cluster.id, nodeId: node.id, vmId: vm.id }, vm, cluster, node });
				}
			}
		}
		return result;
	}

	runningCount(): number {
		return this.allVms().filter((l) => l.vm.state === 'running').length;
	}

	snapshot(): ClusterSnapshot[] {
		return this.clusters().map((rt) => ({
			id: rt.cluster.id,
			name: rt.cluster.name,
			providerId: rt.cluster.providerId,
			providerName: this.registry.displayName(rt.cluster.providerId),
			status: rt.status,
			error: rt.error,
			capabilities: rt.connection?.capabilities,
			nodes: rt.nodes
		}));
	}

	// -----------------------------------------------------------------------------------------
	// Connection lifecycle
	// -----------------------------------------------------------------------------------------

	/** Connects (once) and returns the live connection. Throws with a user-facing message. */
	async connect(clusterId: string): Promise<ClusterConnection> {
		const rt = this.runtimes.get(clusterId);
		if (!rt) throw new Error('Cluster not found');
		if (rt.connection) return rt.connection;
		if (rt.connecting) return rt.connecting;

		rt.connecting = (async () => {
			this.setStatus(rt, 'connecting');
			const provider = await this.registry.ensure(rt.cluster.providerId);
			if (!provider) {
				this.setStatus(rt, 'missingProvider', `Provider "${rt.cluster.providerId}" is not installed`);
				throw new Error(rt.error);
			}
			try {
				const secrets = await this.store.secrets(rt.cluster);
				const connection = await provider.connect(rt.cluster, secrets, {
					storagePath: this.storagePath(rt.cluster),
					log: scopedLogger(`${provider.id}:${rt.cluster.name}`)
				});
				rt.connection = connection;
				rt.changeSubscription = connection.onDidChange?.(() => void this.refresh(clusterId));
				this.setStatus(rt, 'connected');
				return connection;
			} catch (error) {
				this.setStatus(rt, 'error', errorMessage(error));
				throw error;
			}
		})().finally(() => {
			rt.connecting = undefined;
		});
		return rt.connecting;
	}

	async ensureLoaded(clusterId: string): Promise<void> {
		const rt = this.runtimes.get(clusterId);
		if (!rt || rt.loaded || rt.status === 'error' || rt.status === 'missingProvider') return;
		await this.refresh(clusterId);
	}

	/** Refresh one cluster, or every cluster that has been loaded before. */
	async refresh(clusterId?: string): Promise<void> {
		if (clusterId) {
			const rt = this.runtimes.get(clusterId);
			if (rt) await this.refreshRuntime(rt);
			return;
		}
		await Promise.all(this.clusters().map((rt) => this.refreshRuntime(rt)));
	}

	async reconnect(clusterId: string): Promise<void> {
		const rt = this.runtimes.get(clusterId);
		if (!rt) return;
		this.disconnect(rt);
		rt.loaded = false;
		this.setStatus(rt, 'disconnected');
		await this.refreshRuntime(rt);
	}

	private async refreshRuntime(rt: ClusterRuntime): Promise<void> {
		if (rt.refreshing) return rt.refreshing;
		rt.refreshing = (async () => {
			try {
				const connection = await this.connect(rt.cluster.id);
				const nodes = await connection.listNodes();
				const snapshots = await Promise.all(
					nodes.map(async (node): Promise<NodeSnapshot> => {
						if (node.status === 'offline') return { ...node, vms: [] };
						try {
							const vms = await connection.listVms(node.id);
							vms.sort((a, b) => a.name.localeCompare(b.name));
							return { ...node, vms };
						} catch (error) {
							log.warn(`Listing VMs of ${node.name} failed: ${errorMessage(error)}`);
							return { ...node, status: 'unknown', description: errorMessage(error), vms: [] };
						}
					})
				);
				rt.nodes = snapshots;
				rt.loaded = true;
				if (rt.status !== 'connected') this.setStatus(rt, 'connected');
				this.emitter.fire(rt.cluster.id);
				this.updateContextKeys();
			} catch (error) {
				rt.loaded = true;
				if (rt.status !== 'missingProvider') this.setStatus(rt, 'error', errorMessage(error));
				log.warn(`Refreshing ${rt.cluster.name} failed: ${errorMessage(error)}`);
			}
		})().finally(() => {
			rt.refreshing = undefined;
		});
		return rt.refreshing;
	}

	// -----------------------------------------------------------------------------------------
	// Operations
	// -----------------------------------------------------------------------------------------

	async power(ref: VmRef, action: PowerAction): Promise<void> {
		const connection = await this.connect(ref.clusterId);
		await connection.power(ref.nodeId, ref.vmId, action);
		await this.refresh(ref.clusterId);
		// Many hypervisors report transitional states for a few seconds; refresh again shortly.
		setTimeout(() => void this.refresh(ref.clusterId), 2500);
	}

	// -----------------------------------------------------------------------------------------
	// Polling (only while something is visible)
	// -----------------------------------------------------------------------------------------

	setVisible(source: string, visible: boolean): void {
		if (visible) this.visibility.add(source);
		else this.visibility.delete(source);
		this.updateTimer(false);
	}

	private updateTimer(reset: boolean): void {
		const shouldRun = this.visibility.size > 0;
		if (reset || !shouldRun) {
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
		}
		if (shouldRun && !this.timer) {
			const seconds = vscode.workspace.getConfiguration('vmm').get<number>('refreshInterval', 5);
			this.timer = setInterval(() => {
				for (const rt of this.clusters()) {
					if (rt.loaded && rt.status === 'connected') void this.refreshRuntime(rt);
				}
			}, Math.max(1, seconds) * 1000);
		}
	}

	// -----------------------------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------------------------

	private storagePath(cluster: StoredCluster): string {
		return path.join(this.context.globalStorageUri.fsPath, 'providers', cluster.providerId, cluster.id);
	}

	private setStatus(rt: ClusterRuntime, status: ClusterStatus, error?: string): void {
		rt.status = status;
		rt.error = error;
		this.emitter.fire(rt.cluster.id);
	}

	private disconnect(rt: ClusterRuntime): void {
		rt.changeSubscription?.dispose();
		rt.changeSubscription = undefined;
		try {
			rt.connection?.dispose();
		} catch (error) {
			log.warn(`Disposing connection failed: ${errorMessage(error)}`);
		}
		rt.connection = undefined;
	}

	private syncFromStore(): void {
		const stored = this.store.all();
		const ids = new Set(stored.map((c) => c.id));
		for (const [id, rt] of this.runtimes) {
			if (!ids.has(id)) {
				this.disconnect(rt);
				this.runtimes.delete(id);
			}
		}
		for (const cluster of stored) {
			const rt = this.runtimes.get(cluster.id);
			if (!rt) {
				this.runtimes.set(cluster.id, { cluster, status: 'disconnected', nodes: [], loaded: false });
			} else if (JSON.stringify(rt.cluster) !== JSON.stringify(cluster)) {
				// Configuration changed: drop the connection, reload lazily.
				this.disconnect(rt);
				rt.cluster = cluster;
				rt.nodes = [];
				rt.loaded = false;
				rt.status = 'disconnected';
				rt.error = undefined;
			}
		}
		this.updateContextKeys();
		this.emitter.fire(undefined);
	}

	private retryMissingProviders(): void {
		for (const rt of this.runtimes.values()) {
			if (rt.status === 'missingProvider' && this.registry.get(rt.cluster.providerId)) {
				rt.loaded = false;
				rt.status = 'disconnected';
				rt.error = undefined;
				void this.refreshRuntime(rt);
			}
		}
		this.emitter.fire(undefined);
	}

	private updateContextKeys(): void {
		void vscode.commands.executeCommand('setContext', 'vmm.hasClusters', this.store.all().length > 0);
		void vscode.commands.executeCommand('setContext', 'vmm.hasVms', this.allVms().length > 0);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		for (const rt of this.runtimes.values()) this.disconnect(rt);
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
