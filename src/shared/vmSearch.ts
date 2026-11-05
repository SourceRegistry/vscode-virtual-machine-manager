import type { VmInfo } from '@vmm/sdk';

/** Lower-case, and for MAC addresses also without separators, so `52:54:00:ab`, `5254.00ab` and `525400ab` all match. */
function variants(value: string): string[] {
	const lower = value.toLowerCase();
	const bare = lower.replace(/[:.-]/g, '');
	return bare === lower ? [lower] : [lower, bare];
}

/** What a search can match on: name, id, IPs and MACs, plus where the VM lives. */
export function searchableText(vm: VmInfo, extra: string[] = []): string {
	return [vm.name, vm.id, vm.displayId, ...(vm.ipAddresses ?? []), ...(vm.macAddresses ?? []), ...extra]
		.filter((v): v is string => !!v)
		.flatMap(variants)
		.join('\n');
}

/**
 * Every whitespace-separated word of the query must match. `#105` matches ids that start with 105;
 * anything else is a substring of the name, id, an IP, a MAC (any separators), the cluster or the node.
 * An empty query matches all.
 */
export function matchesQuery(query: string, vm: VmInfo, extra: string[] = []): boolean {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const text = searchableText(vm, extra);
	const ids = [vm.id, vm.displayId].filter((v): v is string => !!v).map((v) => v.toLowerCase());
	return words.every((word) => {
		if (word.startsWith('#')) {
			const wanted = word.slice(1);
			return !wanted || ids.some((id) => id.startsWith(wanted));
		}
		if (text.includes(word)) return true;
		// A MAC typed with other separators than stored; an IP-looking word must not be stripped.
		return /^[0-9a-f:.-]+$/.test(word) && !/^[\d.]+$/.test(word) && text.includes(word.replace(/[:.-]/g, ''));
	});
}
