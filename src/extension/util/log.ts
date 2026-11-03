import * as vscode from 'vscode';
import type { Logger } from '@vmm/sdk';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
	channel = vscode.window.createOutputChannel('VM Manager', { log: true });
	context.subscriptions.push(channel);
	return channel;
}

export function scopedLogger(scope: string): Logger {
	const prefix = `[${scope}] `;
	return {
		info: (m) => channel?.info(prefix + m),
		warn: (m) => channel?.warn(prefix + m),
		error: (m) => channel?.error(typeof m === 'string' ? prefix + m : m),
		debug: (m) => channel?.debug(prefix + m)
	};
}

export const log = scopedLogger('core');

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Show an error notification with a "Show Log" action. */
export async function showError(prefix: string, error: unknown): Promise<void> {
	const message = `${prefix}: ${errorMessage(error)}`;
	log.error(message);
	const choice = await vscode.window.showErrorMessage(message, 'Show Log');
	if (choice === 'Show Log') channel?.show(true);
}
