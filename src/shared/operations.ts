/**
 * Power operations in flight. The manager overlays them on the VM list so the tree and the
 * overview show the transition (spinner, "Shutting down…") until the hypervisor call returns,
 * even while the hypervisor still reports the old state.
 */
import type { PowerAction, VmState } from '@vmm/sdk';

/** State shown while the operation runs. */
export const OPERATION_STATE: Record<PowerAction, VmState> = {
	start: 'starting',
	shutdown: 'stopping',
	reboot: 'stopping',
	stop: 'stopping',
	reset: 'stopping'
};

export const OPERATION_LABEL: Record<PowerAction, string> = {
	start: 'Starting…',
	shutdown: 'Shutting down…',
	reboot: 'Rebooting…',
	stop: 'Powering off…',
	reset: 'Resetting…'
};

/** Progress title, e.g. "Shutting down web-01". */
export const OPERATION_TITLE: Record<PowerAction, string> = {
	start: 'Starting',
	shutdown: 'Shutting down',
	reboot: 'Rebooting',
	stop: 'Powering off',
	reset: 'Resetting'
};

/**
 * Actions still offered while another one runs: only a hard power-off, which is what you need
 * when a graceful shutdown hangs.
 */
export function allowedDuring(running: PowerAction, next: PowerAction): boolean {
	return next === 'stop' && running !== 'stop';
}
