/**
 * Noticing when machines change state between two listings, and whether VS Code asked for it. Pure, unit tested;
 * the connection manager feeds it every listing and turns the result into log entries, notifications and API events.
 */
import type { PowerAction, VmState } from '@vmm/sdk';

/** States a machine rests in. Transitional and unknown states are skipped: a change is only seen once it settles. */
const SETTLED: ReadonlySet<VmState> = new Set(['running', 'stopped', 'paused', 'saved']);

export interface ListedVm {
	key: string;
	name: string;
	state: VmState;
}

export interface StateChange {
	key: string;
	name: string;
	from: VmState;
	to: VmState;
}

/**
 * Remembers the last settled state of every machine of a cluster. The first listing of a cluster (or of a new
 * machine) only records; later ones report what changed.
 */
export class StateTracker {
	private readonly clusters = new Map<string, Map<string, { name: string; state: VmState }>>();

	update(clusterId: string, vms: readonly ListedVm[]): StateChange[] {
		const known = this.clusters.get(clusterId);
		const next = new Map<string, { name: string; state: VmState }>();
		const changes: StateChange[] = [];
		for (const vm of vms) {
			const before = known?.get(vm.key);
			if (!SETTLED.has(vm.state)) {
				// Still on its way: keep what it was, so running → stopping → stopped reads as running → stopped.
				if (before) next.set(vm.key, before);
				continue;
			}
			if (before && before.state !== vm.state) changes.push({ key: vm.key, name: vm.name, from: before.state, to: vm.state });
			next.set(vm.key, { name: vm.name, state: vm.state });
		}
		this.clusters.set(clusterId, next);
		return changes;
	}

	/** Forget a cluster (removed, or its configuration changed): its next listing records again. */
	reset(clusterId: string): void {
		this.clusters.delete(clusterId);
	}
}

/** A power action asked for from VS Code (a command, the Overview, a task, the API). */
export interface PowerRequest {
	action: PowerAction;
	at: number;
}

/** How long a request still explains a change: a guest can take minutes to boot or shut down. */
const REQUEST_EXPLAINS_MS: Record<PowerAction, number> = {
	start: 5 * 60_000,
	shutdown: 15 * 60_000,
	stop: 5 * 60_000,
	reboot: 10 * 60_000,
	reset: 5 * 60_000
};

/** What each request leads to; a reboot or reset ends where it started. */
const REQUEST_LEADS_TO: Record<PowerAction, readonly VmState[]> = {
	start: ['running'],
	shutdown: ['stopped', 'saved'],
	stop: ['stopped', 'saved'],
	reboot: ['running'],
	reset: ['running']
};

/** `vscode` when a recent request from here explains the change, `outside` otherwise (the guest, another tool, a crash). */
export function causeOf(change: StateChange, request: PowerRequest | undefined, now: number): 'vscode' | 'outside' {
	if (!request || now - request.at > REQUEST_EXPLAINS_MS[request.action]) return 'outside';
	return REQUEST_LEADS_TO[request.action].includes(change.to) ? 'vscode' : 'outside';
}

const STATE_WORD: Record<VmState, string> = {
	running: 'running',
	stopped: 'off',
	paused: 'paused',
	saved: 'saved',
	starting: 'starting',
	stopping: 'stopping',
	unknown: 'unknown'
};

/** `web-01 stopped outside VS Code`, `web-01 is running`: for a notification and the machine's log. */
export function describeChange(change: Pick<StateChange, 'name' | 'from' | 'to'>, cause: 'vscode' | 'outside'): string {
	const where = cause === 'outside' ? ' outside VS Code' : '';
	if (change.to === 'running') return change.from === 'paused' ? `${change.name} resumed${where}` : `${change.name} started${where}`;
	if (change.to === 'stopped') return `${change.name} stopped${where}`;
	if (change.to === 'paused') return `${change.name} was paused${where}`;
	if (change.to === 'saved') return `${change.name} was saved${where}`;
	return `${change.name} is ${STATE_WORD[change.to]}${where}`;
}

/** The `vmm.notifications.stateChanges` setting. */
export type NotifyMode = 'outside' | 'all' | 'off';

export function shouldNotify(mode: NotifyMode, cause: 'vscode' | 'outside'): boolean {
	return mode === 'all' || (mode === 'outside' && cause === 'outside');
}
