/** The body of the "Delete virtual machine" confirmation. `snapshots` is how many the VM has, if known. */
export function deleteVmDetail(snapshots: number | undefined): string {
	const base = 'This cannot be undone. A running machine is powered off first.';
	if (!snapshots) return base;
	const count = snapshots === 1 ? '1 snapshot is' : `${snapshots} snapshots are`;
	return `${base}\n\n${count} stored in its disks. "Delete VM and Disks" removes ${snapshots === 1 ? 'it' : 'them'} too. "Delete VM" keeps the disk files, with ${snapshots === 1 ? 'the snapshot' : 'the snapshots'}, on this computer.`;
}
