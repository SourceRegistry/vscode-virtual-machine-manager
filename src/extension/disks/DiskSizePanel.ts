import * as vscode from 'vscode';
import type { DiskSizeAnswer, DiskSizeRequest } from '../../shared/protocol';
import { bytesProblem } from '../../shared/disks';
import { panelIcon, renderHtml, WebviewChannel, webviewOptions } from '../webview/WebviewHost';

export const DISK_SIZE_VIEW_TYPE = 'vmm.diskSize';

/**
 * A small form in an editor tab that asks for a disk size: a number field with steps and a unit, which VS Code's
 * own input box cannot offer. Resolves with the answer, or `undefined` when the tab is closed or cancelled.
 */
export function askDiskSize(extensionUri: vscode.Uri, request: DiskSizeRequest): Promise<DiskSizeAnswer | undefined> {
	const title = request.mode === 'grow' ? `Grow ${request.diskLabel ?? 'disk'} — ${request.vmName}` : `Add a disk — ${request.vmName}`;
	const panel = vscode.window.createWebviewPanel(DISK_SIZE_VIEW_TYPE, title, vscode.ViewColumn.Active, webviewOptions(extensionUri));
	panel.iconPath = panelIcon(extensionUri, 'settings');
	panel.webview.html = renderHtml(panel.webview, extensionUri, { view: 'diskSize', title, vmName: request.vmName, diskSize: request });
	return new Promise((resolve) => {
		let answered = false;
		const finish = (answer: DiskSizeAnswer | undefined) => {
			if (answered) return;
			answered = true;
			resolve(answer);
			channel.dispose();
			panel.dispose();
		};
		const channel = new WebviewChannel(panel.webview, {
			submitDiskSize: async (answer) => {
				// The page checks too; this is the check that counts.
				const problem = typeof answer?.bytes === 'number' ? bytesProblem(answer.bytes, request.currentBytes) : 'Enter a size.';
				if (problem) throw new Error(problem);
				const format = request.mode === 'add' ? (request.formats?.includes(answer.format!) ? answer.format : request.formats?.[0]) : undefined;
				finish({ bytes: answer.bytes, ...(format ? { format } : {}) });
			},
			cancelDiskSize: async () => finish(undefined)
		});
		panel.onDidDispose(() => finish(undefined));
	});
}
