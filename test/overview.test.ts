import { describe, expect, it } from 'vitest';
import type { PowerAction, VmState } from '@vmm/sdk';
import { eligibleFor, filterRows, flattenVms, nodeAllocation, sortRows, stateCounts, totalAllocation, type VmRow } from '../src/shared/overview';
import type { ClusterSnapshot, NodeSnapshot, VmSnapshot } from '../src/shared/protocol';

const vm = (id: string, name: string, state: VmState, extra: Partial<VmSnapshot> = {}): VmSnapshot => ({ id, name, state, ...extra });
const node = (id: string, vms: VmSnapshot[], extra: Partial<NodeSnapshot> = {}): NodeSnapshot => ({ id, name: id, status: 'online', vms, ...extra });
const cluster = (id: string, nodes: NodeSnapshot[]): ClusterSnapshot => ({
	id,
	name: id.toUpperCase(),
	providerId: 'p',
	providerName: 'P',
	status: 'connected',
	nodes
});

const clusters = [
	cluster('a', [
		node('n1', [vm('1', 'web-10', 'running', { cpus: 2, memoryMB: 2048, uptimeSeconds: 100, ipAddresses: ['10.0.0.5'] }), vm('2', 'web-2', 'stopped', { cpus: 4, memoryMB: 4096 })], { cpus: 8, memoryMB: 16384 })
	]),
	cluster('b', [node('n2', [vm('3', 'db', 'running', { cpus: 1, memoryMB: 1024, uptimeSeconds: 5 }), vm('4', 'old', 'paused')], { cpus: 4, memoryMB: 8192 })])
];
const rows = flattenVms(clusters);
const names = (r: VmRow[]) => r.map((x) => x.vm.name);

describe('flattenVms', () => {
	it('flattens clusters and nodes with stable keys and refs', () => {
		expect(rows).toHaveLength(4);
		expect(rows[0]).toMatchObject({ key: 'a/n1/1', ref: { clusterId: 'a', nodeId: 'n1', vmId: '1' } });
	});
});

describe('filterRows', () => {
	it('matches name, cluster, node and IP text, case-insensitively', () => {
		expect(names(filterRows(rows, { text: 'WEB' }))).toEqual(['web-10', 'web-2']);
		expect(names(filterRows(rows, { text: '10.0.0.5' }))).toEqual(['web-10']);
		expect(names(filterRows(rows, { text: 'n2' }))).toEqual(['db', 'old']);
		expect(names(filterRows(rows, { text: '  ' }))).toHaveLength(4);
	});

	it('filters by state and combines with text', () => {
		expect(names(filterRows(rows, { states: new Set<VmState>(['running']) }))).toEqual(['web-10', 'db']);
		expect(names(filterRows(rows, { states: new Set<VmState>(['running']), text: 'web' }))).toEqual(['web-10']);
		expect(names(filterRows(rows, { states: new Set<VmState>() }))).toHaveLength(4);
	});
});

describe('sortRows', () => {
	it('sorts names naturally (web-2 before web-10)', () => {
		expect(names(sortRows(rows, 'name', 'asc'))).toEqual(['db', 'old', 'web-2', 'web-10']);
		expect(names(sortRows(rows, 'name', 'desc'))).toEqual(['web-10', 'web-2', 'old', 'db']);
	});

	it('sorts by state with running first, ties by name', () => {
		expect(names(sortRows(rows, 'state', 'asc'))).toEqual(['db', 'web-10', 'old', 'web-2']);
	});

	it('sinks rows without a value in both directions', () => {
		expect(names(sortRows(rows, 'cpus', 'asc'))).toEqual(['db', 'web-10', 'web-2', 'old']);
		expect(names(sortRows(rows, 'cpus', 'desc'))).toEqual(['web-2', 'web-10', 'db', 'old']);
		expect(names(sortRows(rows, 'uptime', 'desc'))).toEqual(['web-10', 'db', 'old', 'web-2']);
	});

	it('sorts by live CPU usage when known', () => {
		const usage = new Map([['a/n1/1', 0.9], ['b/n2/3', 0.1]]);
		expect(names(sortRows(rows, 'cpu', 'desc', usage)).slice(0, 2)).toEqual(['web-10', 'db']);
	});

	it('does not mutate its input', () => {
		const before = names(rows);
		sortRows(rows, 'name', 'desc');
		expect(names(rows)).toEqual(before);
	});
});

describe('summaries', () => {
	it('counts states', () => {
		expect(stateCounts(rows)).toMatchObject({ running: 2, stopped: 1, paused: 1, saved: 0 });
	});

	it('allocates only running VMs against the host', () => {
		expect(nodeAllocation(clusters[0]!.nodes[0]!)).toEqual({ vcpus: 2, memoryMB: 2048, hostCpus: 8, hostMemoryMB: 16384, running: 1, total: 2 });
		expect(totalAllocation(clusters)).toEqual({ vcpus: 3, memoryMB: 3072, hostCpus: 12, hostMemoryMB: 24576, running: 2, total: 4 });
	});

	it('ignores offline nodes in the host totals', () => {
		const offline = [cluster('c', [node('n3', [], { status: 'offline', cpus: 64, memoryMB: 1_000_000 })])];
		expect(totalAllocation(offline)).toMatchObject({ hostCpus: 0, hostMemoryMB: 0 });
	});
});

describe('eligibleFor', () => {
	const all: PowerAction[] = ['start', 'shutdown', 'reboot', 'stop'];
	it('mirrors the single-VM rules', () => {
		expect(eligibleFor('start', vm('x', 'x', 'stopped'), all)).toBe(true);
		expect(eligibleFor('start', vm('x', 'x', 'running'), all)).toBe(false);
		expect(eligibleFor('shutdown', vm('x', 'x', 'running'), all)).toBe(true);
		expect(eligibleFor('shutdown', vm('x', 'x', 'stopped'), all)).toBe(false);
		expect(eligibleFor('stop', vm('x', 'x', 'paused'), all)).toBe(true);
		expect(eligibleFor('stop', vm('x', 'x', 'stopped'), all)).toBe(false);
	});

	it('only allows a hard power-off while another operation runs', () => {
		const busy = vm('x', 'x', 'stopping', { operation: 'shutdown' });
		expect(eligibleFor('stop', busy, all)).toBe(true);
		expect(eligibleFor('shutdown', busy, all)).toBe(false);
		expect(eligibleFor('start', busy, all)).toBe(false);
	});

	it('only offers a power-off for an attached VM without a control channel', () => {
		const blind = vm('x', 'x', 'running', { controllable: false });
		expect(eligibleFor('stop', blind, all)).toBe(true);
		expect(eligibleFor('shutdown', blind, all)).toBe(false);
		expect(eligibleFor('reboot', blind, all)).toBe(false);
	});

	it('requires provider support', () => {
		expect(eligibleFor('shutdown', vm('x', 'x', 'running'), ['start'])).toBe(false);
		expect(eligibleFor('start', vm('x', 'x', 'stopped'), undefined)).toBe(false);
	});
});
