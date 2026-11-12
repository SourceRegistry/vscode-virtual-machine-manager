/**
 * Machines for other extensions, tasks, keybindings and launch configurations: list them, find one by name,
 * power it and wait for it, and ask where to reach it. Exported as `VmManagerApi.vms`.
 */
import * as vscode from 'vscode';
import type { PowerAction, VmControlApi, VmState, VmStateChangeEvent, VmSummary } from '@vmm/sdk';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import type { VmMarksStore } from '../tree/VmMarksStore';
import { lookupVm, vmHandle } from '../../shared/vmLookup';
import { chooseSshTarget, usableAddress } from '../../shared/ssh';
import { probeSsh } from '../ssh/probe';

const POLL_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class VmControl implements VmControlApi, vscode.Disposable {
	private readonly stateEmitter = new vscode.EventEmitter<VmStateChangeEvent>();
	readonly onDidChangeState = this.stateEmitter.event;
	private readonly subscription: vscode.Disposable;

	constructor(
		private readonly manager: ConnectionManager,
		private readonly marks: VmMarksStore
	) {
		this.subscription = manager.onDidChangeVmState((changes) => {
			for (const change of changes) {
				const location = manager.findVm(change.ref);
				if (location) this.stateEmitter.fire({ vm: this.summary(location), from: change.from, to: change.to, cause: change.cause });
			}
		});
	}

	private summary(location: VmLocation): VmSummary {
		return {
			id: vmHandle(location.ref),
			name: location.vm.name,
			cluster: location.cluster.cluster.name,
			node: location.node.name,
			state: location.vm.state,
			ipAddresses: [...(location.vm.ipAddresses ?? [])],
			tags: this.marks.tags(location.ref)
		};
	}

	private async loadAll(): Promise<void> {
		await Promise.all(this.manager.clusters().map((rt) => this.manager.ensureLoaded(rt.cluster.id)));
	}

	/** The machine a name, `cluster/name` or id stands for; rejects with a message for the user otherwise. */
	async resolve(query: string): Promise<VmLocation> {
		await this.loadAll();
		const all = this.manager.allVms();
		const found = lookupVm(
			all.map((l) => ({ ...l.ref, clusterName: l.cluster.cluster.name, name: l.vm.name, location: l })),
			query
		);
		if ('error' in found) throw new Error(found.error);
		return found.vm.location;
	}

	async list(): Promise<VmSummary[]> {
		await this.loadAll();
		return this.manager.allVms().map((l) => this.summary(l));
	}

	async get(vm: string): Promise<VmSummary | undefined> {
		try {
			return this.summary(await this.resolve(vm));
		} catch {
			return undefined;
		}
	}

	async power(vm: string, action: PowerAction): Promise<void> {
		const location = await this.resolve(vm);
		const caps = location.cluster.connection?.capabilities;
		if (caps && !caps.power.includes(action)) throw new Error(`${location.vm.name}: this hypervisor cannot ${action} it.`);
		if (location.vm.template) throw new Error(`${location.vm.name} is a template: it cannot be started, only cloned.`);
		await this.manager.power(location.ref, action);
	}

	/** The machine now, from a fresh listing. */
	private async current(location: VmLocation): Promise<VmLocation | undefined> {
		await this.manager.refresh(location.ref.clusterId);
		return this.manager.findVm(location.ref);
	}

	async waitForState(vm: string, state: VmState, timeoutMs = 5 * 60_000, token?: { isCancellationRequested: boolean }): Promise<VmSummary> {
		const location = await this.resolve(vm);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const now = await this.current(location);
			if (!now) throw new Error(`${location.vm.name} is no longer listed.`);
			// A running operation shows its transitional state, so a shutdown that is still waiting does not count as done.
			if (now.vm.state === state && !now.vm.operation) return this.summary(now);
			if (token?.isCancellationRequested) throw new Error('Cancelled.');
			if (Date.now() >= deadline) throw new Error(`${location.vm.name} is not ${state} after ${Math.round(timeoutMs / 1000)} s (it is ${now.vm.state}).`);
			await sleep(POLL_MS);
		}
	}

	async address(vm: string, options: { ssh?: boolean; timeoutMs?: number } = {}, token?: { isCancellationRequested: boolean }): Promise<{ host: string; port?: number } | undefined> {
		const location = await this.resolve(vm);
		const deadline = Date.now() + (options.timeoutMs ?? 0);
		for (;;) {
			const found = await this.findAddress(location, !!options.ssh);
			if (found) return found;
			if (token?.isCancellationRequested || Date.now() >= deadline) return undefined;
			await sleep(POLL_MS);
		}
	}

	private async findAddress(location: VmLocation, ssh: boolean): Promise<{ host: string; port?: number } | undefined> {
		const now = await this.current(location);
		if (!now || now.vm.state !== 'running') return undefined;
		const connection = now.cluster.connection;
		const details = await connection?.getVmDetails?.(now.ref.nodeId, now.ref.vmId).catch(() => undefined);
		if (!ssh) {
			const address = [...(now.vm.ipAddresses ?? []), ...(details?.nics.flatMap((n) => (n.reachable === false ? [] : n.ipAddresses ?? [])) ?? [])].find(usableAddress);
			return address ? { host: address } : undefined;
		}
		const target = details ? chooseSshTarget(details) : now.vm.ipAddresses?.filter(usableAddress).map((host) => ({ host, port: 22 }))[0];
		if (!target) return undefined;
		// A forward accepts connections before sshd runs in the guest: only a banner proves it answers.
		const probe = await probeSsh(target.host, target.port, 3000);
		return probe.ok ? { host: target.host, port: target.port } : undefined;
	}

	dispose(): void {
		this.subscription.dispose();
		this.stateEmitter.dispose();
	}
}
