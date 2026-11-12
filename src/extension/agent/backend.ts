/**
 * `AgentBackend` on top of the extension: machines through `VmControl` (names, waiting, addresses) and the
 * cluster connections, every change written to the machine's log as done by an AI agent.
 */
import { isAbsolute } from 'node:path';
import type { Capabilities, PowerAction, Snapshot, VmState } from '@vmm/sdk';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import type { VmControl } from '../api/VmControl';
import type { AgentBackend, AgentCluster, AgentVm } from './tools';
import { vmHandle } from '../../shared/vmLookup';

export interface AgentActivity {
	record(location: VmLocation, text: string, level?: 'info' | 'warn' | 'error'): void;
}

export class ExtensionAgentBackend implements AgentBackend {
	constructor(
		private readonly manager: ConnectionManager,
		private readonly control: VmControl,
		private readonly activity: AgentActivity,
		/** Says who asked, in the machine's log: "Copilot", "an MCP client". */
		private readonly via: string
	) {}

	private agentVm(location: VmLocation): AgentVm {
		const vm = location.vm;
		return {
			id: vmHandle(location.ref),
			name: vm.name,
			cluster: location.cluster.cluster.name,
			node: location.node.name,
			state: vm.operation ? (({ start: 'starting', shutdown: 'stopping', stop: 'stopping', reboot: 'stopping', reset: 'starting' } as const)[vm.operation] ?? vm.state) : vm.state,
			ipAddresses: [...(vm.ipAddresses ?? [])],
			...(vm.cpus !== undefined ? { cpus: vm.cpus } : {}),
			...(vm.memoryMB !== undefined ? { memoryMB: vm.memoryMB } : {}),
			...(vm.os ? { os: vm.os } : {}),
			...(vm.template ? { template: true } : {}),
			...(vm.guestKind ? { kind: vm.guestKind } : {}),
			favorite: !!vm.favorite,
			groups: [...(vm.groups ?? [])]
		};
	}

	/** The machine and its live connection. */
	private async open(query: string) {
		const location = await this.control.resolve(query);
		const connection = await this.manager.connect(location.ref.clusterId);
		return { location, connection, caps: connection.capabilities };
	}

	private record(location: VmLocation, text: string, level?: 'info' | 'warn' | 'error') {
		this.activity.record(location, `${text} (asked by ${this.via})`, level);
	}

	async clusters(): Promise<AgentCluster[]> {
		await Promise.all(this.manager.clusters().map((rt) => this.manager.ensureLoaded(rt.cluster.id).catch(() => undefined)));
		return this.manager.clusters().map((rt) => ({
			name: rt.cluster.name,
			provider: rt.cluster.providerId,
			status: rt.status,
			nodes: rt.nodes.map((n) => ({ name: n.name, status: n.status, vms: n.vms.length }))
		}));
	}

	async list(): Promise<AgentVm[]> {
		await this.control.list();
		return this.manager.allVms().map((l) => this.agentVm(l));
	}

	async get(query: string): Promise<{ vm: AgentVm; capabilities: Capabilities }> {
		const { location, caps } = await this.open(query);
		return { vm: this.agentVm(location), capabilities: caps };
	}

	async details(query: string) {
		const { location, connection } = await this.open(query);
		if (!connection.getVmDetails) throw new Error('This hypervisor does not report machine details.');
		return connection.getVmDetails(location.ref.nodeId, location.ref.vmId);
	}

	async stats(query: string) {
		const { location, connection } = await this.open(query);
		if (!connection.getVmStats) throw new Error('This hypervisor does not report usage.');
		if (location.vm.state !== 'running') throw new Error(`${location.vm.name} is ${location.vm.state}: usage is only reported while it runs.`);
		return connection.getVmStats(location.ref.nodeId, location.ref.vmId);
	}

	async snapshots(query: string): Promise<Snapshot[]> {
		const { location, connection } = await this.open(query);
		if (!connection.listSnapshots) throw new Error('This hypervisor does not support snapshots.');
		return connection.listSnapshots(location.ref.nodeId, location.ref.vmId);
	}

	address(query: string, options: { ssh: boolean; timeoutMs: number }) {
		return this.control.address(query, options);
	}

	async power(query: string, action: PowerAction): Promise<void> {
		const location = await this.control.resolve(query);
		this.record(location, `${{ start: 'Start', shutdown: 'Shut down', reboot: 'Reboot', stop: 'Power off', reset: 'Reset' }[action]} requested`);
		await this.control.power(query, action);
	}

	async waitForState(query: string, state: VmState, timeoutMs: number): Promise<AgentVm> {
		await this.control.waitForState(query, state, timeoutMs);
		const location = await this.control.resolve(query);
		return this.agentVm(location);
	}

	/** A snapshot by id, or else by its (unique) name. */
	private async snapshot(query: string, which: string): Promise<{ location: VmLocation; snapshot: Snapshot; connection: Awaited<ReturnType<ExtensionAgentBackend['open']>>['connection'] }> {
		const { location, connection } = await this.open(query);
		const list = (await connection.listSnapshots?.(location.ref.nodeId, location.ref.vmId)) ?? [];
		const byId = list.find((s) => s.id === which);
		const byName = list.filter((s) => s.name === which);
		if (!byId && byName.length > 1) throw new Error(`${location.vm.name} has ${byName.length} snapshots named "${which}": use the id.`);
		const snapshot = byId ?? byName[0];
		if (!snapshot) throw new Error(`${location.vm.name} has no snapshot "${which}". Its snapshots: ${list.map((s) => s.name).join(', ') || 'none'}.`);
		return { location, snapshot, connection };
	}

	async takeSnapshot(query: string, name: string): Promise<Snapshot> {
		const { location, connection } = await this.open(query);
		if (!connection.createSnapshot) throw new Error('This hypervisor does not support snapshots.');
		const snapshot = await connection.createSnapshot(location.ref.nodeId, location.ref.vmId, name);
		this.record(location, `Snapshot "${snapshot.name}" taken${snapshot.includesMemory ? ' (with memory)' : ''}`);
		return snapshot;
	}

	async revertSnapshot(query: string, which: string): Promise<Snapshot> {
		const { location, snapshot, connection } = await this.snapshot(query, which);
		if (!connection.revertSnapshot) throw new Error('This hypervisor does not support snapshots.');
		if (connection.capabilities.snapshotRevertNeedsStopped && location.vm.state !== 'stopped') throw new Error(`${location.vm.name} must be stopped before it can be reverted on this hypervisor. Shut it down first.`);
		await connection.revertSnapshot(location.ref.nodeId, location.ref.vmId, snapshot.id);
		this.record(location, `Reverted to snapshot "${snapshot.name}"`);
		await this.manager.refresh(location.ref.clusterId);
		return snapshot;
	}

	async deleteSnapshot(query: string, which: string): Promise<Snapshot> {
		const { location, snapshot, connection } = await this.snapshot(query, which);
		if (!connection.deleteSnapshot) throw new Error('This hypervisor does not support snapshots.');
		await connection.deleteSnapshot(location.ref.nodeId, location.ref.vmId, snapshot.id);
		this.record(location, `Snapshot "${snapshot.name}" deleted`);
		return snapshot;
	}

	private async running(query: string, feature: 'runInGuest' | 'copyToGuest' | 'copyFromGuest' | 'addPortForward') {
		const opened = await this.open(query);
		if (!opened.connection[feature]) throw new Error(feature === 'addPortForward' ? 'This hypervisor cannot forward ports.' : 'This hypervisor has no guest agent support.');
		if (feature !== 'addPortForward' && opened.location.vm.state !== 'running') throw new Error(`${opened.location.vm.name} is ${opened.location.vm.state}: start it first.`);
		return opened;
	}

	async runInGuest(query: string, command: Parameters<AgentBackend['runInGuest']>[1]) {
		const { location, connection } = await this.running(query, 'runInGuest');
		const line = command.shell ? command.command : [command.command, ...(command.args ?? [])].join(' ');
		const result = await connection.runInGuest!(location.ref.nodeId, location.ref.vmId, command);
		this.record(location, `Ran in the guest: ${line} → ${result.timedOut ? 'still running after the timeout' : `exit ${result.exitCode ?? `signal ${result.signal}`}`}`, result.exitCode === 0 ? 'info' : 'warn');
		return result;
	}

	async copyToGuest(query: string, localPath: string, guestPath: string): Promise<void> {
		if (!isAbsolute(localPath)) throw new Error('localPath must be an absolute path on this computer.');
		const { location, connection } = await this.running(query, 'copyToGuest');
		await connection.copyToGuest!(location.ref.nodeId, location.ref.vmId, localPath, guestPath);
		this.record(location, `Copied ${localPath} to ${guestPath} in the guest`);
	}

	async copyFromGuest(query: string, guestPath: string, localPath: string): Promise<void> {
		if (!isAbsolute(localPath)) throw new Error('localPath must be an absolute path on this computer.');
		const { location, connection } = await this.running(query, 'copyFromGuest');
		await connection.copyFromGuest!(location.ref.nodeId, location.ref.vmId, guestPath, localPath);
		this.record(location, `Copied ${guestPath} from the guest to ${localPath}`);
	}

	async addPortForward(query: string, forward: Parameters<AgentBackend['addPortForward']>[1]): Promise<void> {
		const { location, connection } = await this.running(query, 'addPortForward');
		await connection.addPortForward!(location.ref.nodeId, location.ref.vmId, forward);
		this.record(location, `Forwarded ${forward.hostAddress ?? '127.0.0.1'}:${forward.hostPort} to guest port ${forward.guestPort}/${forward.protocol}`);
		await this.manager.refresh(location.ref.clusterId);
	}
}
