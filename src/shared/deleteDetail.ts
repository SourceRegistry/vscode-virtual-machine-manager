/** The body of the "Delete virtual machine" confirmation. `snapshots` is how many the VM has, if known. */
export function deleteVmDetail(snapshots: number | undefined): string {
	const base = 'This cannot be undone. A running machine is powered off first.';
	if (!snapshots) return base;
	const count = snapshots === 1 ? '1 snapshot is' : `${snapshots} snapshots are`;
	return `${base}\n\n${count} stored in its disks. "Delete VM and Disks" removes ${snapshots === 1 ? 'it' : 'them'} too. "Delete VM" keeps the disk files, with ${snapshots === 1 ? 'the snapshot' : 'the snapshots'}, on this computer.`;
}

/** The body of the "Delete N virtual machines" confirmation: which ones, and how many selected ones are left alone. */
export function deleteVmsDetail(names: string[], skipped = 0): string {
	const shown = 10;
	const list = names.length > shown ? `${names.slice(0, shown).join(', ')} and ${names.length - shown} more` : names.join(', ');
	const left = skipped ? `\n\n${skipped === 1 ? '1 other selected machine cannot be deleted and is' : `${skipped} other selected machines cannot be deleted and are`} left alone.` : '';
	return `${list}\n\nThis cannot be undone. Running machines are powered off first. "Delete VMs and Disks" also removes their disk files, with any snapshots stored in them.${left}`;
}
