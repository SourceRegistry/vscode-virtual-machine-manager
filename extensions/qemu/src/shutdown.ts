import { ProviderError } from '@vmm/sdk';

/** What the shutdown ladder needs from the VM; injected so the logic is unit testable. */
export interface ShutdownSteps {
	/**
	 * Asks the guest agent to shut down (or reboot). Resolves `false` when no agent answers, so the
	 * ladder falls through to ACPI.
	 */
	agent?: () => Promise<boolean>;
	/** Sends the ACPI power button press (`system_powerdown`). */
	acpi: () => Promise<void>;
	/** Resolves `true` as soon as the VM has stopped, `false` after `timeoutMs`. */
	waitStopped: (timeoutMs: number) => Promise<boolean>;
}

export type ShutdownMethod = 'agent' | 'acpi';

/** Share of the timeout the guest agent gets before the ACPI request is sent as well. */
const AGENT_SHARE = 1 / 3;

/**
 * Graceful shutdown ladder: guest agent → ACPI → give up with a `timeout` error.
 * A guest that ignores both (an installer, a bare UEFI shell, a locked-down desktop) must not leave
 * the VM "stopping" forever; the caller decides whether to force it off.
 */
export async function gracefulShutdown(steps: ShutdownSteps, timeoutMs: number, name: string): Promise<ShutdownMethod> {
	let method: ShutdownMethod = 'acpi';
	let remaining = timeoutMs;
	if (steps.agent && (await steps.agent().catch(() => false))) {
		method = 'agent';
		const agentWait = Math.min(remaining, Math.max(1, Math.round(timeoutMs * AGENT_SHARE)));
		if (await steps.waitStopped(agentWait)) return method;
		remaining -= agentWait;
	}
	await steps.acpi();
	if (await steps.waitStopped(remaining)) return method;
	throw new ProviderError(
		`${name} did not shut down within ${Math.round(timeoutMs / 1000)} seconds. The guest may not handle power-button (ACPI) requests, e.g. an installer or a firmware shell.`,
		'timeout'
	);
}
