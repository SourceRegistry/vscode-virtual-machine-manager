import type { Snapshot } from '@vmm/sdk';

/** A snapshot as `qemu-img info --output=json` and QMP `query-block` report it. */
export interface QemuSnapshotInfo {
	id?: string;
	name?: string;
	'vm-state-size'?: number;
	'date-sec'?: number;
}

/** The parts of a QMP `query-block` entry that carry snapshots. */
export interface QmpSnapshotBlock {
	device?: string;
	inserted?: { 'node-name'?: string; image?: { format?: string; snapshots?: QemuSnapshotInfo[] } };
}

const NAME = /^[\w .()-]{1,64}$/;

/** `undefined` when the name can be used; otherwise what is wrong with it. */
export function snapshotNameProblem(name: string): string | undefined {
	if (!NAME.test(name) || name !== name.trim()) return 'Use 1–64 letters, digits, spaces or . _ ( ) - for the name, without leading or trailing spaces';
	return undefined;
}

/**
 * Snapshots that exist on every disk, named the same: only those can be reverted as a whole.
 * qcow2 keeps them per disk, so one taken while a disk was missing, or deleted from one disk only,
 * is dropped here instead of being offered half-way.
 */
export function commonSnapshots(perDisk: QemuSnapshotInfo[][]): Snapshot[] {
	if (!perDisk.length) return [];
	const [first, ...rest] = perDisk;
	const common = first!.filter((snap) => snap.name && rest.every((other) => other.some((o) => o.name === snap.name)));
	return common
		.map<Snapshot>((snap) => ({
			id: snap.name!,
			name: snap.name!,
			createdAt: snap['date-sec'] ? snap['date-sec'] * 1000 : undefined,
			includesMemory: (snap['vm-state-size'] ?? 0) > 0
		}))
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** Snapshots of each disk of a running VM, from `query-block`. Disks without a qcow2 image are left out. */
export function qmpSnapshots(blocks: QmpSnapshotBlock[], deviceIds: string[]): QemuSnapshotInfo[][] {
	return deviceIds.map((id) => blocks.find((b) => b.device === id || b.inserted?.['node-name'] === id)?.inserted?.image?.snapshots ?? []);
}
