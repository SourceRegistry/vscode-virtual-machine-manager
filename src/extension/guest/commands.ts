/**
 * Running commands in a guest and copying files to and from it, through the provider's guest agent
 * support (`runInGuest`, `copyToGuest`, `copyFromGuest`).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import { showError } from '../util/log';
import { defaultGuestPath, formatGuestRun, guestBaseName, guestRunStatus, transferText } from '../../shared/guest';

let output: vscode.OutputChannel | undefined;

/** One channel for every guest command, so a session's commands read as a transcript. */
function guestOutput(context: vscode.ExtensionContext): vscode.OutputChannel {
	if (!output) {
		output = vscode.window.createOutputChannel('VM Manager: Guest Commands');
		context.subscriptions.push(output);
	}
	return output;
}

const key = (location: VmLocation, what: string) => `vmm.guest.${what}.${location.ref.clusterId}/${location.ref.vmId}`;

export async function runCommandInGuest(context: vscode.ExtensionContext, manager: ConnectionManager, location: VmLocation): Promise<void> {
	const { ref, vm } = location;
	const command = await vscode.window.showInputBox({
		title: `Run in ${vm.name}`,
		prompt: 'A command line for the guest\'s shell (/bin/sh, cmd.exe on Windows). It runs as the guest agent\'s user, usually root.',
		value: context.workspaceState.get<string>(key(location, 'command')) ?? 'uname -a',
		ignoreFocusOut: true
	});
	if (!command?.trim()) return;
	await context.workspaceState.update(key(location, 'command'), command);
	const channel = guestOutput(context);
	try {
		const connection = await manager.connect(ref.clusterId);
		if (!connection.runInGuest) throw new Error('This hypervisor cannot run commands in a guest');
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Running in ${vm.name}: ${command}` },
			() => connection.runInGuest!(ref.nodeId, ref.vmId, { command, shell: true, timeoutMs: 5 * 60_000 })
		);
		channel.append(formatGuestRun(vm.name, command, result));
		channel.show(true);
		void vscode.window.setStatusBarMessage(`${vm.name}: ${command} ${guestRunStatus(result)}`, 6000);
	} catch (error) {
		await showError(`Could not run the command in ${vm.name}`, error);
	}
}

export async function copyFileToGuest(context: vscode.ExtensionContext, manager: ConnectionManager, location: VmLocation): Promise<void> {
	const { ref, vm } = location;
	const [file] = (await vscode.window.showOpenDialog({ title: `Copy a file to ${vm.name}`, canSelectMany: false, openLabel: 'Copy to Guest' })) ?? [];
	if (!file) return;
	const name = path.basename(file.fsPath);
	const remembered = context.workspaceState.get<string>(key(location, 'dir'));
	const guestPath = await vscode.window.showInputBox({
		title: `Copy ${name} to ${vm.name}`,
		prompt: 'Path in the guest. An existing file is replaced.',
		value: remembered ? `${remembered}${remembered.includes('\\') ? '\\' : '/'}${name}` : defaultGuestPath(name, vm.os?.toLowerCase().includes('windows')),
		ignoreFocusOut: true
	});
	if (!guestPath?.trim()) return;
	await context.workspaceState.update(key(location, 'dir'), guestPath.replace(/[\\/][^\\/]*$/, '') || '/');
	try {
		const connection = await manager.connect(ref.clusterId);
		if (!connection.copyToGuest) throw new Error('This hypervisor cannot copy files to a guest');
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Copying ${name} to ${vm.name}` }, (progress) => {
			let last = 0;
			return connection.copyToGuest!(ref.nodeId, ref.vmId, file.fsPath, guestPath, (p) => {
				const percent = p.total ? (100 * p.done) / p.total : 0;
				progress.report({ message: transferText(p), increment: p.total ? percent - last : undefined });
				last = percent;
			});
		});
		void vscode.window.setStatusBarMessage(`Copied ${name} to ${vm.name}:${guestPath}`, 5000);
	} catch (error) {
		await showError(`Could not copy ${name} to ${vm.name}`, error);
	}
}

export async function copyFileFromGuest(context: vscode.ExtensionContext, manager: ConnectionManager, location: VmLocation): Promise<void> {
	const { ref, vm } = location;
	const guestPath = await vscode.window.showInputBox({
		title: `Copy a file from ${vm.name}`,
		prompt: 'Path of the file in the guest',
		value: context.workspaceState.get<string>(key(location, 'from')) ?? '/etc/os-release',
		ignoreFocusOut: true
	});
	if (!guestPath?.trim()) return;
	await context.workspaceState.update(key(location, 'from'), guestPath);
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const target = await vscode.window.showSaveDialog({
		title: `Save ${guestBaseName(guestPath)} from ${vm.name}`,
		defaultUri: folder ? vscode.Uri.joinPath(folder, guestBaseName(guestPath)) : undefined,
		saveLabel: 'Copy from Guest'
	});
	if (!target) return;
	try {
		const connection = await manager.connect(ref.clusterId);
		if (!connection.copyFromGuest) throw new Error('This hypervisor cannot copy files from a guest');
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Copying ${guestBaseName(guestPath)} from ${vm.name}` }, (progress) => {
			let last = 0;
			return connection.copyFromGuest!(ref.nodeId, ref.vmId, guestPath, target.fsPath, (p) => {
				const percent = p.total ? (100 * p.done) / p.total : 0;
				progress.report({ message: transferText(p), increment: p.total ? percent - last : undefined });
				last = percent;
			});
		});
		const choice = await vscode.window.showInformationMessage(`Copied ${guestPath} from ${vm.name} to ${target.fsPath}`, 'Open');
		if (choice === 'Open') await vscode.commands.executeCommand('vscode.open', target);
	} catch (error) {
		await showError(`Could not copy ${guestPath} from ${vm.name}`, error);
	}
}
