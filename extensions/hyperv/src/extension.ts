import * as vscode from 'vscode';
import { CORE_EXTENSION_ID, VMM_API_VERSION, checkApiCompatibility, type VmManagerApi } from '@vmm/sdk';
import { HyperVProvider } from './HyperVProvider';
import { PowerShellSession } from './PowerShellSession';
import { PREREQUISITES } from './scripts';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const core = vscode.extensions.getExtension<VmManagerApi>(CORE_EXTENSION_ID);
	if (!core) throw new Error('VM Manager is not installed');
	const api = core.isActive ? core.exports : await core.activate();
	const compatibility = checkApiCompatibility('Hyper-V provider', VMM_API_VERSION, api);
	if (!compatibility.ok) {
		void vscode.window.showErrorMessage(compatibility.message!);
		throw new Error(compatibility.message);
	}
	context.subscriptions.push(
		api.registerProvider(new HyperVProvider()) as vscode.Disposable,
		vscode.commands.registerCommand('vmm.hyperv.checkPrerequisites', checkPrerequisites)
	);
}

interface Prerequisites {
	Module: boolean;
	Service: string;
	IsAdmin: boolean;
	IsHyperVAdmin: boolean;
	User: string;
}

async function checkPrerequisites(): Promise<void> {
	if (process.platform !== 'win32') {
		void vscode.window.showErrorMessage('Hyper-V is only available on Windows.');
		return;
	}
	const session = new PowerShellSession('prerequisites');
	try {
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Checking Hyper-V…' },
			() => session.first<Prerequisites>(PREREQUISITES)
		);
		if (!result) throw new Error('No result');
		const problems: string[] = [];
		const fixes: string[] = [];
		if (!result.Module || result.Service === 'Missing') {
			problems.push('Hyper-V is not enabled.');
			fixes.push('Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All');
		} else if (result.Service !== 'Running') {
			problems.push(`The Hyper-V Virtual Machine Management service is ${result.Service}.`);
			fixes.push('Start-Service vmms');
		}
		if (!result.IsAdmin && !result.IsHyperVAdmin) {
			problems.push(`${result.User} is not a member of "Hyper-V Administrators".`);
			fixes.push(`Add-LocalGroupMember -Group "Hyper-V Administrators" -Member "${result.User}"`);
		}
		if (!problems.length) {
			void vscode.window.showInformationMessage('Hyper-V is ready to use with VM Manager.');
			return;
		}
		const choice = await vscode.window.showWarningMessage(
			'Hyper-V is not ready yet',
			{
				modal: true,
				detail: `${problems.join('\n')}\n\nRun the following in an elevated PowerShell, then sign out and in (or reboot after enabling the feature):\n\n${fixes.join('\n')}`
			},
			'Copy Commands'
		);
		if (choice === 'Copy Commands') await vscode.env.clipboard.writeText(fixes.join('\n'));
	} catch (error) {
		void vscode.window.showErrorMessage(`Checking Hyper-V failed: ${(error as Error).message}`);
	} finally {
		session.dispose();
	}
}

export function deactivate(): void {}
