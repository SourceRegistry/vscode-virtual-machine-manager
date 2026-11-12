/** Favorites, the user's own groups of machines, and how the main tree groups them. Pure, unit tested. */
import type { VmState } from '@vmm/sdk';

/** How the Virtual Machines view groups machines: by cluster (cluster › node), by the user's groups, or by state. */
export type GroupBy = 'cluster' | 'group' | 'state';

/** What the user marked on a machine; kept by the core, not the hypervisor. */
export interface VmMarks {
	favorite?: boolean;
	/** Names of the user's groups the machine is in (a machine can be in several). */
	groups?: string[];
}

const MAX_NAME = 40;

/** The name the Favorites group shows; not available for a group of one's own. */
export const FAVORITES_LABEL = 'Favorites';

/** One group name as typed: trimmed, inner spaces collapsed, at most 40 characters. Empty when nothing is left. */
export function cleanName(input: string): string {
	return input.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
}

/** Names without empty ones or duplicates (ignoring case), each kept as first spelled. */
export function uniqueNames(names: Iterable<string>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of names) {
		const name = cleanName(raw);
		if (!name || seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());
		result.push(name);
	}
	return result;
}

export const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What is wrong with a new group name, given the groups there are (`except`: the group being renamed). */
export function groupNameProblem(name: string, existing: readonly string[], except?: string): string | undefined {
	const clean = cleanName(name);
	if (!clean) return 'Give the group a name.';
	if (sameName(clean, FAVORITES_LABEL)) return `"${FAVORITES_LABEL}" is taken: use Add to Favorites for that.`;
	if (existing.some((g) => sameName(g, clean) && !(except && sameName(g, except)))) return `There is already a group called "${clean}".`;
	return undefined;
}

export interface GroupedVm {
	key: string;
	name: string;
	state: VmState;
	groups?: readonly string[];
}

export interface VmGroup {
	/** Stable across refreshes: `group:<lowercase name>`, `state:<state>`, `ungrouped`. */
	id: string;
	label: string;
	keys: string[];
}

const STATE_ORDER: VmState[] = ['running', 'starting', 'stopping', 'paused', 'saved', 'stopped', 'unknown'];
const STATE_GROUP: Record<VmState, string> = {
	running: 'Running',
	starting: 'Starting',
	stopping: 'Stopping',
	paused: 'Paused',
	saved: 'Saved',
	stopped: 'Off',
	unknown: 'Unknown'
};

/** The id of the user's group called `name`. */
export const groupId = (name: string) => `group:${name.toLowerCase()}`;

/**
 * Groups for the main tree by `group` (the user's groups in their order, empty ones included, then *Not in a
 * group*) or by `state` (empty ones left out). A machine in two groups is listed in both.
 */
export function groupVms(vms: readonly GroupedVm[], by: Exclude<GroupBy, 'cluster'>, groupOrder: readonly string[] = []): VmGroup[] {
	const byName = [...vms].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
	if (by === 'state') {
		return STATE_ORDER.map((state) => ({ id: `state:${state}`, label: STATE_GROUP[state], keys: byName.filter((v) => v.state === state).map((v) => v.key) })).filter((g) => g.keys.length);
	}
	const groups = new Map<string, VmGroup>(uniqueNames(groupOrder).map((name) => [groupId(name), { id: groupId(name), label: name, keys: [] }]));
	const ungrouped: string[] = [];
	for (const vm of byName) {
		const names = uniqueNames(vm.groups ?? []);
		if (!names.length) ungrouped.push(vm.key);
		for (const name of names) {
			const group = groups.get(groupId(name)) ?? { id: groupId(name), label: name, keys: [] };
			group.keys.push(vm.key);
			groups.set(group.id, group);
		}
	}
	return ungrouped.length ? [...groups.values(), { id: 'ungrouped', label: 'Not in a group', keys: ungrouped }] : [...groups.values()];
}
