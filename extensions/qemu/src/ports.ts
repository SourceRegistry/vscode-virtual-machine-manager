/** Helpers for starting several VMs without fighting over local ports. Pure, unit tested. */

/** QEMU's wording when a listener (VNC, QMP, serial, agent) cannot bind its port. */
export function isPortConflict(output: string): boolean {
	return /address already in use|failed to find an available port|failed to bind|eaddrinuse/i.test(output);
}

/**
 * Runs tasks one at a time, in order. A failing task does not block the ones queued behind it.
 * Starting VMs through it means each one has bound its ports before the next picks its own: a port
 * probe only tests a port, it cannot hold it, so two parallel starts would both choose 5900.
 */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task, task);
		this.tail = result.catch(() => undefined);
		return result;
	}
}
