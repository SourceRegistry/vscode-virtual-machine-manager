/** Port forwards of QEMU user-mode networking. Pure module: no I/O, unit tested. */
import type { PortForward } from '@vmm/sdk';

/** Host side of a forward when none is given: loopback only, so a forward never exposes the guest to the LAN by accident. */
export const DEFAULT_HOST_ADDRESS = '127.0.0.1';

function isPort(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Returns an error message, or `undefined` when the forward is usable. */
export function validateForward(forward: PortForward): string | undefined {
	if (forward.protocol !== 'tcp' && forward.protocol !== 'udp') return 'Protocol must be TCP or UDP';
	if (!isPort(forward.hostPort)) return 'Host port must be between 1 and 65535';
	if (!isPort(forward.guestPort)) return 'Guest port must be between 1 and 65535';
	if (forward.hostAddress !== undefined && !/^(\d{1,3}\.){3}\d{1,3}$/.test(forward.hostAddress)) return 'Host address must be an IPv4 address';
	return undefined;
}

/** Fills in the default host address. */
export function normalizeForward(forward: PortForward): PortForward {
	return { protocol: forward.protocol, hostAddress: forward.hostAddress || DEFAULT_HOST_ADDRESS, hostPort: forward.hostPort, guestPort: forward.guestPort };
}

/** Two forwards occupy the same host socket. */
export function sameHostSocket(a: PortForward, b: PortForward): boolean {
	return a.protocol === b.protocol && a.hostPort === b.hostPort && (a.hostAddress || DEFAULT_HOST_ADDRESS) === (b.hostAddress || DEFAULT_HOST_ADDRESS);
}

/** The rule as QEMU spells it, e.g. `tcp:127.0.0.1:2222-:22` (used by `hostfwd=` and the HMP commands). */
export function forwardRule(forward: PortForward): string {
	const f = normalizeForward(forward);
	return `${f.protocol}:${f.hostAddress}:${f.hostPort}-:${f.guestPort}`;
}

/** `-nic user,…` option fragments for the stored forwards. */
export function hostfwdOptions(forwards: readonly PortForward[] | undefined): string {
	return (forwards ?? []).map((f) => `,hostfwd=${forwardRule(f)}`).join('');
}

/** HMP command lines. The first user-mode network is the default target, so no netdev id is given. */
export function addCommand(forward: PortForward): string {
	return `hostfwd_add ${forwardRule(forward)}`;
}

/** `hostfwd_remove` names only the host side of the rule. */
export function removeCommand(forward: PortForward): string {
	const f = normalizeForward(forward);
	return `hostfwd_remove ${f.protocol}:${f.hostAddress}:${f.hostPort}`;
}

/**
 * HMP reports failure as plain text in the command's return value (success prints nothing).
 * Returns the message, or `undefined` for success.
 */
export function hmpError(output: string | undefined): string | undefined {
	const text = (output ?? '').trim();
	return text ? text : undefined;
}
