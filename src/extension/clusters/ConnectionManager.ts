import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ClusterConnection, PowerAction } from '@vmm/sdk';
import type { ClusterSnapshot, ClusterStatus, NodeSnapshot, VmRef, VmSnapshot } from '../../shared/protocol';
import type { ClusterStore, StoredCluster } from './ClusterStore';
import type { ProviderRegistry } from '../registry/ProviderRegistry';
import { errorMessage, log, scopedLogger } from '../util/log';
import { OPERATION_LABEL, OPERATION_STATE, allowedDuring } from '../../shared/operations';

/** How long a graceful shutdown keeps the VM shown as shutting down after the request was sent. */
const SHUTDOWN_WAIT_MS = 10 * 60_000;

function vmKey(ref: VmRef): string {
	return `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;
}

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
	/** The user ended the session: do not reconnect (and ask for credentials) until they ask. */
	signedOut?: boolean;
	/** The user cancelled a connection attempt; shown as such until they try again. */
	cancelled?: boolean;
	/** An automatic connect needed the user (password, 2FA, browser): wait for them to ask. */
	signInRequired?: boolean;
	abort?: AbortController;
}

export interface VmLocation {
	ref: VmRef;
	vm: VmSnapshot;
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
	/** Power operations in flight, by VM (see `power`). */
	private readonly operations = new Map<string, { action: PowerAction }>();
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
	async connect(clusterId: string, interactive = false): Promise<ClusterConnection> {
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
			const abort = (rt.abort = new AbortController());
			try {
				const secrets = await this.store.secrets(rt.cluster);
				const attempt = provider.connect(rt.cluster, secrets, {
					storagePath: this.storagePath(rt.cluster),
					log: scopedLogger(`${provider.id}:${rt.cluster.name}`),
					signal: abort.signal,
					interactive
				});
				// A provider that is waiting on the user cannot always be interrupted: stop waiting for it anyway.
				const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('Connection cancelled.')), { once: true }));
				// If the provider finishes after the user cancelled, nobody owns that connection any more.
				attempt.then((late) => { if (abort.signal.aborted) late.dispose(); }, () => {});
				const connection = await Promise.race([attempt, cancelled]);
				rt.connection = connection;
				rt.changeSubscription = connection.onDidChange?.(() => void this.refresh(clusterId));
				this.setStatus(rt, 'connected');
				return connection;
			} catch (error) {
				if ((error as { code?: string }).code === 'authRequired') {
					// Not a failure: the provider needs the user. Wait until they click connect.
					rt.signedOut = true;
					rt.signInRequired = true;
					this.setStatus(rt, 'disconnected');
					throw error;
				}
				if (abort.signal.aborted) {
					// Cancelled by the user: not a failure. Stay idle until they connect again.
					rt.signedOut = true;
					rt.cancelled = true;
					this.setStatus(rt, 'disconnected');
					throw error;
				}
				this.setStatus(rt, 'error', errorMessage(error));
				throw error;
			}
		})().finally(() => {
			rt.connecting = undefined;
			rt.abort = undefined;
		});
		return rt.connecting;
	}

	async ensureLoaded(clusterId: string): Promise<void> {
		const rt = this.runtimes.get(clusterId);
		if (!rt || rt.loaded || rt.signedOut || rt.status === 'error' || rt.status === 'missingProvider') return;
		// Opening the view must never prompt: a provider that needs the user reports it instead.
		await this.refreshRuntime(rt);
	}

	/** Refresh one cluster, or every cluster that has been loaded before. */
	async refresh(clusterId?: string): Promise<void> {
		if (clusterId) {
			const rt = this.runtimes.get(clusterId);
			if (rt) {
				rt.signedOut = false;
				rt.cancelled = false;
				rt.signInRequired = false;
				await this.refreshRuntime(rt, true);
			}
			return;
		}
		await Promise.all(this.clusters().filter((rt) => !rt.signedOut).map((rt) => this.refreshRuntime(rt)));
	}

	/** Stops a connection attempt that is still running (typically a sign-in waiting for the user). */
	cancelConnect(clusterId: string): void {
		this.runtimes.get(clusterId)?.abort?.abort();
	}

	/** Ends the provider's sign-in session, drops the connection and stays disconnected until asked to connect. */
	async signOut(clusterId: string): Promise<void> {
		const rt = this.runtimes.get(clusterId);
		if (!rt) return;
		try {
			await rt.connection?.signOut?.();
		} catch (error) {
			log.warn(`Signing out of ${rt.cluster.name} failed: ${errorMessage(error)}`);
		}
		this.disconnect(rt);
		rt.nodes = [];
		rt.loaded = false;
		rt.signedOut = true;
		rt.cancelled = false;
		rt.signInRequired = false;
		this.setStatus(rt, 'disconnected');
		this.updateContextKeys();
	}

	async reconnect(clusterId: string): Promise<void> {
		const rt = this.runtimes.get(clusterId);
		if (!rt) return;
		rt.signedOut = false;
		rt.cancelled = false;
		rt.signInRequired = false;
		this.disconnect(rt);
		rt.loaded = false;
		this.setStatus(rt, 'disconnected');
		await this.refreshRuntime(rt, true);
	}

	private async refreshRuntime(rt: ClusterRuntime, interactive = false): Promise<void> {
		if (rt.refreshing) return rt.refreshing;
		rt.refreshing = (async () => {
			try {
				const connection = await this.connect(rt.cluster.id, interactive);
				const nodes = await connection.listNodes();
				const snapshots = await Promise.all(
					nodes.map(async (node): Promise<NodeSnapshot> => {
						if (node.status === 'offline') return { ...node, vms: [] };
						try {
							const vms = await connection.listVms(node.id);
							vms.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
							return { ...node, vms };
						} catch (error) {
							log.warn(`Listing VMs of ${node.name} failed: ${errorMessage(error)}`);
							return { ...node, status: 'unknown', description: errorMessage(error), vms: [] };
						}
					})
				);
				// Providers may return nodes in a different order on every poll.
				// Sort before publishing so the tree and overview keep the same order.
				rt.nodes = snapshots.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
				this.applyOperations(rt.cluster.id, false);
				rt.loaded = true;
				if (rt.status !== 'connected') this.setStatus(rt, 'connected');
				this.emitter.fire(rt.cluster.id);
				this.updateContextKeys();
			} catch (error) {
				if (rt.signedOut) return;
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

	/** The power operation running on a VM, if any. */
	operation(ref: VmRef): PowerAction | undefined {
		return this.operations.get(vmKey(ref))?.action;
	}

	/**
	 * Runs a power operation as a background task: the VM shows its transitional state right away
	 * and the returned promise settles when the hypervisor call returns (a graceful shutdown can
	 * take minutes). Only a hard power-off may start while another operation runs.
	 */
	async power(ref: VmRef, action: PowerAction): Promise<void> {
		const key = vmKey(ref);
		const running = this.operations.get(key);
		if (running && !allowedDuring(running.action, action)) {
			throw new Error(`${OPERATION_LABEL[running.action].replace('…', '')} is already in progress.`);
		}
		const operation = { action };
		this.operations.set(key, operation);
		this.applyOperations(ref.clusterId);
		try {
			const connection = await this.connect(ref.clusterId);
			await connection.power(ref.nodeId, ref.vmId, action);
			// Some hypervisors only send the ACPI request (QEMU): the guest is still shutting down.
			if (action === 'shutdown') await this.waitUntilOff(connection, ref, () => this.operations.get(key) === operation);
		} finally {
			// A later operation (power-off during a shutdown) replaced this one: leave it.
			if (this.operations.get(key) === operation) this.operations.delete(key);
			await this.refresh(ref.clusterId);
			// Many hypervisors report transitional states for a few seconds; refresh again shortly.
			setTimeout(() => void this.refresh(ref.clusterId), 2500);
		}
	}

	private async waitUntilOff(connection: ClusterConnection, ref: VmRef, current: () => boolean): Promise<void> {
		const deadline = Date.now() + SHUTDOWN_WAIT_MS;
		while (current() && Date.now() < deadline) {
			const vm = await connection.listVms(ref.nodeId).then(
				(vms) => vms.find((v) => v.id === ref.vmId),
				() => undefined // Listing failed: stop waiting, the next refresh shows the state.
			);
			if (!vm || vm.state === 'stopped' || vm.state === 'saved') return;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}

	/** Shows running operations as transitional states (the hypervisor may still report the old one). */
	private applyOperations(clusterId: string, notify = true): void {
		const rt = this.runtimes.get(clusterId);
		if (!rt) return;
		for (const node of rt.nodes) {
			node.vms = node.vms.map((vm) => {
				const operation = this.operations.get(vmKey({ clusterId, nodeId: node.id, vmId: vm.id }))?.action;
				if (!operation) return vm.operation ? { ...vm, operation: undefined } : vm;
				return { ...vm, operation, state: OPERATION_STATE[operation] };
			});
		}
		if (notify) this.emitter.fire(clusterId);
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
		// Remembered console credentials only exist for providers that open RDP consoles (Hyper-V).
		void vscode.commands.executeCommand('setContext', 'vmm.hasRdpClusters', this.clusters().some((rt) => rt.connection?.capabilities.consoles.includes('rdp')));
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		for (const rt of this.runtimes.values()) this.disconnect(rt);
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
