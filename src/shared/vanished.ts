import type { VmRef } from './protocol';

export interface ObservedVm {
	id: string;
	name: string;
	/** Attached from outside rather than created here (`VmInfo.origin === 'adopted'`). */
	adopted: boolean;
}

/** One node's VM listing as seen by a refresh. */
export interface ObservedNode {
	nodeId: string;
	/** The listing succeeded and the node is reachable. A failed, offline or unknown node proves nothing about its VMs. */
	listed: boolean;
	vms: ObservedVm[];
}

/** A VM concluded gone, with what was last known about it (it can no longer be looked up). */
export interface GoneVm {
	ref: VmRef;
	name: string;
	adopted: boolean;
}

const key = (ref: VmRef) => `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;

/**
 * Notices virtual machines that were there and are gone, so their tabs can be closed. Closing someone's
 * tab by mistake is worse than leaving a stale one, so it is deliberately slow to conclude:
 *
 *  - only a VM that was seen before can vanish;
 *  - only a node whose listing succeeded can say a VM is gone (a failed or offline node says nothing);
 *  - the VM must be missing from `MISSES_NEEDED` successful listings in a row, so one odd listing
 *    (a hypervisor busy, a migration in flight) does not close anything.
 */
export class VanishedVms {
	static readonly MISSES_NEEDED = 2;
	private readonly known = new Map<string, GoneVm>();
	private readonly misses = new Map<string, number>();

	/** Feeds one refresh of a cluster. Returns the VMs that have just been concluded gone. */
	update(clusterId: string, nodes: ObservedNode[]): GoneVm[] {
		const gone: GoneVm[] = [];
		for (const node of nodes) {
			if (!node.listed) continue;
			const present = new Set(node.vms.map((vm) => vm.id));
			for (const vm of node.vms) {
				const ref = { clusterId, nodeId: node.nodeId, vmId: vm.id };
				this.known.set(key(ref), { ref, name: vm.name, adopted: vm.adopted });
				this.misses.delete(key(ref));
			}
			for (const [k, entry] of this.known) {
				const { ref } = entry;
				if (ref.clusterId !== clusterId || ref.nodeId !== node.nodeId || present.has(ref.vmId)) continue;
				const count = (this.misses.get(k) ?? 0) + 1;
				if (count >= VanishedVms.MISSES_NEEDED) {
					this.known.delete(k);
					this.misses.delete(k);
					gone.push(entry);
				} else {
					this.misses.set(k, count);
				}
			}
		}
		return gone;
	}

	/** The cluster was removed: everything in it is gone. */
	removeCluster(clusterId: string): GoneVm[] {
		const gone = [...this.known.values()].filter((entry) => entry.ref.clusterId === clusterId);
		this.reset(clusterId);
		return gone;
	}

	/** The cluster was reconfigured: start over without concluding anything. */
	reset(clusterId: string): void {
		for (const [k, entry] of this.known) {
			if (entry.ref.clusterId !== clusterId) continue;
			this.known.delete(k);
			this.misses.delete(k);
		}
	}

	/** The user deleted or detached this VM themselves: it is not to be reported later. */
	forget(ref: VmRef): void {
		this.known.delete(key(ref));
		this.misses.delete(key(ref));
	}
}
