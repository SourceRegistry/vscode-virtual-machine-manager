/**
 * Pure logic of the overview dashboard: one flat VM list across all clusters, filtering, sorting,
 * state counts, resource allocation and which power actions apply. No DOM, no vscode.
 */
import type { Capabilities, PowerAction, VmState } from '@vmm/sdk';
import { allowedDuring } from './operations';
import type { ClusterSnapshot, NodeSnapshot, VmRef, VmSnapshot } from './protocol';

export interface VmRow {
	key: string;
	ref: VmRef;
	cluster: ClusterSnapshot;
	node: NodeSnapshot;
	vm: VmSnapshot;
}

export function refKey(ref: VmRef): string {
	return `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;
}

export function flattenVms(clusters: ClusterSnapshot[]): VmRow[] {
	return clusters.flatMap((cluster) =>
		cluster.nodes.flatMap((node) =>
			node.vms.map((vm) => {
				const ref = { clusterId: cluster.id, nodeId: node.id, vmId: vm.id };
				return { key: refKey(ref), ref, cluster, node, vm };
			})
		)
	);
}

// ---- filter & sort ----------------------------------------------------------------------------

export function filterRows(rows: VmRow[], filter: { text?: string; states?: ReadonlySet<VmState> }): VmRow[] {
	const text = filter.text?.trim().toLowerCase();
	return rows.filter(({ vm, cluster, node }) => {
		if (filter.states?.size && !filter.states.has(vm.state)) return false;
		if (!text) return true;
		return [vm.name, vm.os, vm.description, cluster.name, node.name, ...(vm.ipAddresses ?? [])].some((v) => v?.toLowerCase().includes(text));
	});
}

export type SortKey = 'state' | 'name' | 'location' | 'cpus' | 'memory' | 'cpu' | 'uptime';
export type SortDirection = 'asc' | 'desc';

/** Busy first when sorting by state ascending. */
const STATE_ORDER: Record<VmState, number> = { running: 0, starting: 1, stopping: 2, paused: 3, saved: 4, stopped: 5, unknown: 6 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Sorts a copy. Rows without a value for the key always sink to the bottom, in both directions. */
export function sortRows(rows: VmRow[], key: SortKey, direction: SortDirection, cpuUsage: ReadonlyMap<string, number> = new Map()): VmRow[] {
	const value = (row: VmRow): number | string | undefined => {
		switch (key) {
			case 'state':
				return STATE_ORDER[row.vm.state];
			case 'name':
				return row.vm.name;
			case 'location':
				return `${row.cluster.name} ${row.node.name}`;
			case 'cpus':
				return row.vm.cpus;
			case 'memory':
				return row.vm.memoryMB;
			case 'cpu':
				return cpuUsage.get(row.key);
			case 'uptime':
				return row.vm.state === 'running' ? row.vm.uptimeSeconds : undefined;
		}
	};
	const sign = direction === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const va = value(a);
		const vb = value(b);
		if (va === undefined && vb === undefined) return collator.compare(a.vm.name, b.vm.name);
		if (va === undefined) return 1;
		if (vb === undefined) return -1;
		const order = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb));
		return order !== 0 ? order * sign : collator.compare(a.vm.name, b.vm.name);
	});
}

// ---- summaries --------------------------------------------------------------------------------

export function stateCounts(rows: VmRow[]): Record<VmState, number> {
	const counts: Record<VmState, number> = { running: 0, stopped: 0, paused: 0, saved: 0, starting: 0, stopping: 0, unknown: 0 };
	for (const row of rows) counts[row.vm.state]++;
	return counts;
}

export interface Allocation {
	/** vCPUs / memory of the running VMs of this node. */
	vcpus: number;
	memoryMB: number;
	hostCpus?: number;
	hostMemoryMB?: number;
	running: number;
	total: number;
}

export function nodeAllocation(node: NodeSnapshot): Allocation {
	const running = node.vms.filter((v) => v.state === 'running' || v.state === 'starting');
	return {
		vcpus: running.reduce((sum, v) => sum + (v.cpus ?? 0), 0),
		memoryMB: running.reduce((sum, v) => sum + (v.memoryMB ?? 0), 0),
		hostCpus: node.cpus,
		hostMemoryMB: node.memoryMB,
		running: running.length,
		total: node.vms.length
	};
}

/** Whole-estate totals: allocated by running VMs vs what the (online) nodes have. */
export function totalAllocation(clusters: ClusterSnapshot[]): Allocation {
	const nodes = clusters.flatMap((c) => c.nodes).filter((n) => n.status !== 'offline');
	const parts = nodes.map(nodeAllocation);
	const sum = (pick: (a: Allocation) => number | undefined) => parts.reduce((total, a) => total + (pick(a) ?? 0), 0);
	return {
		vcpus: sum((a) => a.vcpus),
		memoryMB: sum((a) => a.memoryMB),
		hostCpus: sum((a) => a.hostCpus),
		hostMemoryMB: sum((a) => a.hostMemoryMB),
		running: sum((a) => a.running),
		total: sum((a) => a.total)
	};
}

// ---- actions ----------------------------------------------------------------------------------

/** Whether `action` applies to a VM right now. Mirrors the single-VM command filters. */
export function eligibleFor(action: PowerAction, vm: VmSnapshot, supported: readonly PowerAction[] | undefined): boolean {
	if (!supported?.includes(action)) return false;
	// A template is never started: it is only copied.
	if (vm.template) return false;
	// Attached without a control channel: nothing but a hard power-off can be asked of it.
	if (vm.controllable === false && action !== 'stop') return false;
	if (vm.operation) return allowedDuring(vm.operation, action);
	switch (action) {
		case 'start':
			return vm.state !== 'running' && vm.state !== 'starting';
		case 'shutdown':
		case 'reboot':
		case 'reset':
			return vm.state === 'running';
		case 'stop':
			return vm.state !== 'stopped';
	}
}

/** Whether a VM can be deleted along with others. An attached VM is not ours to delete: it can only be detached. */
export function eligibleForDelete(vm: VmSnapshot, caps: Pick<Capabilities, 'delete'> | undefined): boolean {
	return !!caps?.delete && vm.origin !== 'adopted';
}
