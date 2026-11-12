/**
 * Finding a machine from what a person types in tasks.json, a keybinding or another extension: its id
 * (`cluster/node/vm`, as the API returns it), `cluster/name`, or just its name. Pure, unit tested.
 */

export interface LookupVm {
	clusterId: string;
	clusterName: string;
	nodeId: string;
	vmId: string;
	name: string;
}

/** The id the API hands out for a machine: stable across renames, unique across clusters. */
export function vmHandle(vm: { clusterId: string; nodeId: string; vmId: string }): string {
	return [vm.clusterId, vm.nodeId, vm.vmId].map(encodeURIComponent).join('/');
}

export type LookupResult<T> = { vm: T } | { error: string };

export function lookupVm<T extends LookupVm>(vms: readonly T[], query: string): LookupResult<T> {
	const q = query.trim();
	if (!q) return { error: 'Name a virtual machine.' };
	const byHandle = vms.find((vm) => vmHandle(vm) === q);
	if (byHandle) return { vm: byHandle };
	const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
	// `cluster/name`: a name that contains a slash still matches as a whole first.
	let matches = vms.filter((vm) => same(vm.name, q));
	if (!matches.length && q.includes('/')) {
		const slash = q.indexOf('/');
		const [cluster, name] = [q.slice(0, slash), q.slice(slash + 1)];
		matches = vms.filter((vm) => same(vm.clusterName, cluster) && same(vm.name, name));
	}
	if (matches.length === 1) return { vm: matches[0] };
	if (!matches.length) return { error: `No virtual machine is called "${q}".` };
	const where = matches.map((vm) => `${vm.clusterName}/${vm.name}`).join(', ');
	return { error: `More than one virtual machine is called "${q}" (${where}); write it as cluster/name.` };
}
