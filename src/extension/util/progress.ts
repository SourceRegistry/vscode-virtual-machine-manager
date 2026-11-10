import * as vscode from 'vscode';

/**
 * Runs `task` and, if it is still going after `delayMs`, shows a progress notification until it ends. Quick work
 * stays silent; slow work (an SSH connection, a scan of a remote host) says what it is doing.
 */
export async function withDelayedProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>, delayMs = 400): Promise<T> {
	let report: (message: string) => void = () => undefined;
	let pending: string | undefined;
	let finished = false;
	let release: () => void = () => undefined;
	const timer = setTimeout(() => {
		if (finished) return;
		void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, (progress) => {
			report = (message) => progress.report({ message });
			if (pending) report(pending);
			return new Promise<void>((resolve) => (release = resolve));
		});
	}, delayMs);
	try {
		return await task((message) => {
			pending = message;
			report(message);
		});
	} finally {
		finished = true;
		clearTimeout(timer);
		release();
	}
}
