import * as vscode from 'vscode';
import { CORE_EXTENSION_ID, VMM_API_VERSION, type VmManagerApi } from '@vmm/sdk';
import { detectQemu } from './detect';
import { QemuProvider } from './QemuProvider';

const configuredPath = () => vscode.workspace.getConfiguration('vmm.qemu').get<string>('path') || undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const core = vscode.extensions.getExtension<VmManagerApi>(CORE_EXTENSION_ID);
	if (!core) throw new Error('VM Manager is not installed');
	const api = core.isActive ? core.exports : await core.activate();
	if (api.apiVersion !== VMM_API_VERSION) {
		void vscode.window.showWarningMessage(
			`VM Manager – QEMU expects API version ${VMM_API_VERSION} but VM Manager provides ${api.apiVersion}. Update both extensions.`
		);
	}
	context.subscriptions.push(
		api.registerProvider(new QemuProvider({ defaultQemuPath: configuredPath })) as vscode.Disposable,
		vscode.commands.registerCommand('vmm.qemu.detect', detect)
	);
}

async function detect(): Promise<void> {
	try {
		const qemu = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Detecting QEMU…' },
			() => detectQemu(configuredPath())
		);
		const firmware = qemu.firmwareCode ? 'UEFI firmware found.' : 'No UEFI firmware found — only BIOS guests are available.';
		const choice = await vscode.window.showInformationMessage(
			`QEMU ${qemu.version} found in ${qemu.directory}. ${firmware}`,
			configuredPath() === qemu.directory ? 'OK' : 'Use This Path',
			'Add Cluster'
		);
		if (choice === 'Use This Path') {
			await vscode.workspace.getConfiguration('vmm.qemu').update('path', qemu.directory, vscode.ConfigurationTarget.Global);
		} else if (choice === 'Add Cluster') {
			await vscode.commands.executeCommand('vmm.addCluster');
		}
	} catch (error) {
		const choice = await vscode.window.showErrorMessage((error as Error).message, 'Download QEMU', 'Open Settings');
		if (choice === 'Download QEMU') await vscode.env.openExternal(vscode.Uri.parse('https://www.qemu.org/download/'));
		if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'vmm.qemu.path');
	}
}

export function deactivate(): void {}
