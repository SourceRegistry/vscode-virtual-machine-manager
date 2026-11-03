import type { StatusType } from '#lib/client-lib/components/feedback/Status.svelte';
import type { VmState } from '@vmm/sdk';

/** client-lib <Status> states for VM power states (colours come from the VS Code theme bridge). */
export const vmStates: Record<VmState, StatusType> = {
	running: { color: 'var(--color-success)', title: 'Running' },
	stopped: { color: 'var(--color-text-muted)', title: 'Off' },
	paused: { color: 'var(--color-warning)', title: 'Paused' },
	saved: { color: 'var(--color-info)', title: 'Saved' },
	starting: { color: 'var(--color-info)', title: 'Starting…' },
	stopping: { color: 'var(--color-warning)', title: 'Stopping…' },
	unknown: { color: 'var(--color-text-secondary)', title: 'Unknown' }
};

export const clusterStates: Record<string, StatusType> = {
	connected: { color: 'var(--color-success)', title: 'Connected' },
	connecting: { color: 'var(--color-info)', title: 'Connecting…' },
	disconnected: { color: 'var(--color-text-muted)', title: 'Not connected' },
	error: { color: 'var(--color-danger)', title: 'Connection failed' },
	missingProvider: { color: 'var(--color-warning)', title: 'Provider not installed' }
};
