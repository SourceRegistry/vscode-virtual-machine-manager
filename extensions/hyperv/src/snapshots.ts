import type { Snapshot } from '@vmm/sdk';

export interface RawSnapshot {
	Id: string;
	Name: string;
	/** Milliseconds since the epoch. */
	Created?: number | null;
}

/** Oldest first. `Get-VMSnapshot` returns a tree in no promised order. */
export function toSnapshots(raw: RawSnapshot[]): Snapshot[] {
	return [...raw]
		.sort((a, b) => (a.Created ?? 0) - (b.Created ?? 0))
		.map((s) => ({ id: s.Id, name: s.Name, ...(s.Created ? { createdAt: s.Created } : {}) }));
}
