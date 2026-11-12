/** Favorites, tags and the tree's grouping (by cluster, tag or state). Pure, unit tested. */
import type { VmState } from '@vmm/sdk';

export type GroupBy = 'cluster' | 'tag' | 'state';

/** What the user marked on a machine; kept by the core, not the hypervisor. */
export interface VmMarks {
	favorite?: boolean;
	tags?: string[];
}

const MAX_TAG = 40;

/** `web, Lab ,web` → `['web', 'Lab']`: trimmed, no empty ones, no duplicates (ignoring case), at most 40 characters each. */
export function parseTags(input: string | readonly string[]): string[] {
	const parts = typeof input === 'string' ? input.split(',') : input;
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const part of parts) {
		const tag = part.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG);
		if (!tag || seen.has(tag.toLowerCase())) continue;
		seen.add(tag.toLowerCase());
		tags.push(tag);
	}
	return tags;
}

/** Every tag in use, sorted, each spelled as it was first seen. */
export function allTags(marks: Iterable<VmMarks>): string[] {
	return parseTags([...marks].flatMap((m) => m.tags ?? [])).sort((a, b) => a.localeCompare(b));
}

export interface GroupedVm {
	key: string;
	name: string;
	state: VmState;
	tags?: readonly string[];
}

export interface VmGroup {
	/** Stable across refreshes: `tag:<lowercase tag>`, `state:<state>`, `untagged`. */
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

/** Groups for `tag` or `state` (empty groups left out). A machine with two tags is in both; one without any is under *Untagged*. */
export function groupVms(vms: readonly GroupedVm[], by: Exclude<GroupBy, 'cluster'>): VmGroup[] {
	const byName = [...vms].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
	if (by === 'state') {
		return STATE_ORDER.map((state) => ({ id: `state:${state}`, label: STATE_GROUP[state], keys: byName.filter((v) => v.state === state).map((v) => v.key) })).filter((g) => g.keys.length);
	}
	const groups = new Map<string, VmGroup>();
	const untagged: string[] = [];
	for (const vm of byName) {
		const tags = parseTags(vm.tags ?? []);
		if (!tags.length) untagged.push(vm.key);
		for (const tag of tags) {
			const id = `tag:${tag.toLowerCase()}`;
			const group = groups.get(id) ?? { id, label: tag, keys: [] };
			group.keys.push(vm.key);
			groups.set(id, group);
		}
	}
	const sorted = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
	return untagged.length ? [...sorted, { id: 'untagged', label: 'Untagged', keys: untagged }] : sorted;
}
