/** The time shown next to a power operation in progress ("Shutting down… 23 s left"). Pure, unit tested. */
import type { PowerAction } from '@vmm/sdk';
import { OPERATION_LABEL } from './operations';

/** Operations quicker than this show no time at all. */
const QUIET_MS = 3000;

/**
 * `Shutting down… 23 s left` while a graceful shutdown or reboot waits for the guest and the provider says how
 * long it waits; past that, or for anything else, the time so far: `Starting… 12 s`.
 */
export function operationText(action: PowerAction, startedAt: number, now: number, timeoutSeconds?: number): string {
	const label = OPERATION_LABEL[action];
	const elapsed = Math.max(0, now - startedAt);
	const graceful = action === 'shutdown' || action === 'reboot';
	if (graceful && timeoutSeconds && timeoutSeconds > 0) {
		const left = Math.ceil(timeoutSeconds - elapsed / 1000);
		if (left > 0) return `${label} ${left} s left`;
	}
	if (elapsed < QUIET_MS) return label;
	return `${label} ${formatSeconds(Math.floor(elapsed / 1000))}`;
}

/** `45 s`, `2 min 05 s`. */
export function formatSeconds(seconds: number): string {
	if (seconds < 60) return `${seconds} s`;
	return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}
