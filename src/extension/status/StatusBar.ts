import * as vscode from 'vscode';
import type { ConnectionManager } from '../clusters/ConnectionManager';

/** Workspace-scoped (left) status item: number of running VMs, opens the overview. */
export class VmStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('vmm.running', vscode.StatusBarAlignment.Left, 50);
	private readonly subscription: vscode.Disposable;

	constructor(private readonly manager: ConnectionManager) {
		this.item.name = 'Running Virtual Machines';
		this.item.command = 'vmm.openOverview';
		this.subscription = manager.onDidChange(() => this.update());
		this.update();
	}

	private update(): void {
		if (!this.manager.clusters().length) {
			this.item.hide();
			return;
		}
		const running = this.manager.runningCount();
		const total = this.manager.allVms().length;
		this.item.text = `$(vm) ${running}`;
		this.item.tooltip = `${running} of ${total} virtual machines running — open overview`;
		this.item.show();
	}

	dispose(): void {
		this.subscription.dispose();
		this.item.dispose();
	}
}
