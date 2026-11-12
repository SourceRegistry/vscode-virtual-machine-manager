/**
 * Whether agents may use a machine's keyboard and mouse: the user's default (`vmm.agent.screenControl`) and
 * per-machine choices (`vmm.agent.screenControlPerMachine`, keyed by name or `cluster/name`). Pure.
 */

/**
 * - `ask`: the first key or click asks; allowed for 15 minutes or until released.
 * - `askEveryTime`: every key or click call asks.
 * - `allow`: never asks.
 * - `deny`: refused.
 */
export type ScreenControlMode = 'ask' | 'askEveryTime' | 'allow' | 'deny';

export const SCREEN_CONTROL_MODES: readonly ScreenControlMode[] = ['ask', 'askEveryTime', 'allow', 'deny'];

const isMode = (value: unknown): value is ScreenControlMode => SCREEN_CONTROL_MODES.includes(value as ScreenControlMode);

/** The mode for one machine: `cluster/name` first, then its name (both ignoring case), else the default. */
export function screenControlMode(vm: { name: string; cluster: string }, fallback: unknown, perMachine: unknown): ScreenControlMode {
	const entries = perMachine && typeof perMachine === 'object' ? Object.entries(perMachine as Record<string, unknown>) : [];
	const find = (key: string) => entries.find(([k, v]) => k.trim().toLowerCase() === key.toLowerCase() && isMode(v))?.[1] as ScreenControlMode | undefined;
	return find(`${vm.cluster}/${vm.name}`) ?? find(vm.name) ?? (isMode(fallback) ? fallback : 'ask');
}
