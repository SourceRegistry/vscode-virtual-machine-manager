/**
 * The `vm` task type (tasks.json): power a machine and wait for it, e.g. as a debug session's `preLaunchTask`.
 * Pure, unit tested; the task provider runs the plan.
 *
 *   { "type": "vm", "vm": "web-01", "action": "start", "waitFor": "ssh" }
 */
import type { PowerAction, VmState } from '@vmm/sdk';

export const TASK_TYPE = 'vm';

export type WaitFor = 'none' | 'state' | 'address' | 'ssh';

export interface VmTaskDefinition {
	type: typeof TASK_TYPE;
	/** Name, `cluster/name` or an API id. */
	vm: string;
	action: PowerAction;
	/** What to wait for after the action: the end state (default), an IP address, an SSH server, or nothing. */
	waitFor?: WaitFor;
	/** Seconds to wait in all (default 300). */
	timeout?: number;
}

const ACTIONS: readonly PowerAction[] = ['start', 'shutdown', 'reboot', 'stop', 'reset'];
const WAITS: readonly WaitFor[] = ['none', 'state', 'address', 'ssh'];

/** What a definition from tasks.json means, or what is wrong with it. */
export function checkDefinition(raw: Record<string, unknown>): { definition: Required<Omit<VmTaskDefinition, 'type'>> } | { error: string } {
	if (typeof raw.vm !== 'string' || !raw.vm.trim()) return { error: 'Say which machine: "vm": "<name>".' };
	if (typeof raw.action !== 'string' || !ACTIONS.includes(raw.action as PowerAction)) return { error: `"action" is one of ${ACTIONS.join(', ')}.` };
	const action = raw.action as PowerAction;
	const waitFor = (raw.waitFor ?? 'state') as WaitFor;
	if (!WAITS.includes(waitFor)) return { error: `"waitFor" is one of ${WAITS.join(', ')}.` };
	if ((waitFor === 'address' || waitFor === 'ssh') && !(action === 'start' || action === 'reboot' || action === 'reset')) {
		return { error: `"waitFor": "${waitFor}" needs the machine running: use it with start, reboot or reset.` };
	}
	const timeout = raw.timeout === undefined ? 300 : Number(raw.timeout);
	if (!Number.isFinite(timeout) || timeout <= 0) return { error: '"timeout" is a number of seconds.' };
	return { definition: { vm: raw.vm.trim(), action, waitFor, timeout } };
}

/** The state an action ends in. */
export function targetState(action: PowerAction): VmState {
	return action === 'shutdown' || action === 'stop' ? 'stopped' : 'running';
}

/** Nothing to do: starting a running machine, shutting down one that is off. A reboot or reset always runs. */
export function alreadyDone(action: PowerAction, state: VmState): boolean {
	if (action === 'start') return state === 'running';
	if (action === 'shutdown' || action === 'stop') return state === 'stopped' || state === 'saved';
	return false;
}

/** The task's label in *Run Task*: `Start web-01`. */
export function taskLabel(action: PowerAction, name: string): string {
	const verb: Record<PowerAction, string> = { start: 'Start', shutdown: 'Shut Down', reboot: 'Reboot', stop: 'Power Off', reset: 'Reset' };
	return `${verb[action]} ${name}`;
}
