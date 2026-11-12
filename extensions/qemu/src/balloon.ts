/**
 * Guest memory from the virtio balloon driver's statistics (QMP `qom-get … guest-stats`). The driver
 * reports what Linux calls MemTotal and MemAvailable; "used" is the difference, which leaves out the
 * page cache the guest would give up, so it matches what `free` shows as used. Pure, unit tested.
 */

/** MB in use, or undefined when the guest has not reported (no driver, not yet polled, or an unsupported stat: -1). */
export function balloonUsedMB(stats: Record<string, number> | undefined, lastUpdate: number | undefined): number | undefined {
	if (!stats || !lastUpdate) return undefined;
	const total = stats['stat-total-memory'];
	const available = stats['stat-available-memory'];
	if (total === undefined || available === undefined || total <= 0 || available < 0 || available > total) return undefined;
	return Math.round((total - available) / (1024 * 1024));
}
