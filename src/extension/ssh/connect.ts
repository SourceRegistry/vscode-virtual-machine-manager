import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { connectAddress, sshCommand } from '../../shared/forwards';
import {
	chooseSshTarget,
	findSshConfigBlock,
	hostAlias,
	listSshConfigBlocks,
	removeSshConfigBlock,
	renderSshConfigBlock,
	upsertSshConfigBlock,
	validSshUser,
	type SshTarget
} from '../../shared/ssh';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import { log, showError } from '../util/log';
import { findFreePort, probeSsh, type SshProbe } from './probe';

export const REMOTE_SSH_ID = 'ms-vscode-remote.remote-ssh';
/** Remote - SSH's own command: with `{ host }` it connects to that host (an ssh config alias or an address) in a new window. */
const OPEN_COMMAND = 'opensshremotes.openEmptyWindow';

const vmKey = (location: VmLocation) => `${location.ref.clusterId}/${location.ref.nodeId}/${location.ref.vmId}`;

/** The file Remote - SSH reads: its own setting, else ~/.ssh/config. */
export function sshConfigPath(): string {
	const configured = vscode.workspace.getConfiguration('remote.SSH').get<string>('configFile');
	if (configured) return configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
	return path.join(os.homedir(), '.ssh', 'config');
}

function describeProbe(probe: Extract<SshProbe, { ok: false }>, target: SshTarget): string {
	const where = `${target.host}:${target.port}`;
	switch (probe.reason) {
		case 'refused':
			return `Connection to ${where} was refused. ${target.via === 'forward' ? 'The port forward is gone, or nothing is listening on this computer.' : 'The machine is not accepting connections on port 22.'}`;
		case 'notSsh':
			return `${where} answered, but not like an SSH server (${probe.detail ?? 'unexpected data'}).`;
		case 'unreachable':
			return `${where} cannot be reached from this computer${probe.detail ? ` (${probe.detail})` : ''}.`;
		default:
			return `Nothing answered as an SSH server on ${where}. The machine may still be booting, or sshd is not installed or running in the guest.`;
	}
}

function readSshConfig(file: string): string {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Writes the ssh config. The previous content is kept once as `<file>.vmm.bak`, and a new file is private to the user. */
function writeSshConfig(file: string, previous: string, next: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	if (previous && !fs.existsSync(`${file}.vmm.bak`)) fs.writeFileSync(`${file}.vmm.bak`, previous, { mode: 0o600 });
	fs.writeFileSync(file, next, { mode: 0o600 });
}

/** How a list of blocks is shown in a confirmation: the first few in full, the rest counted. */
function previewBlocks(blocks: string[], limit = 5): string {
	const shown = blocks.slice(0, limit).join('\n\n');
	return blocks.length > limit ? `${shown}\n\n…and ${blocks.length - limit} more` : shown;
}

async function sshUser(state: vscode.Memento, location: VmLocation): Promise<string | undefined> {
	const storageKey = `vmm.sshUser.${vmKey(location)}`;
	const configured = vscode.workspace.getConfiguration('vmm.ssh').get<string>('user', '').trim();
	const user = await vscode.window.showInputBox({
		title: `SSH user for ${location.vm.name}`,
		prompt: 'The account to sign in as inside the guest. It is remembered for this machine.',
		value: state.get<string>(storageKey) || configured || os.userInfo().username,
		validateInput: (value) => (validSshUser(value.trim()) ? undefined : 'Letters, digits, . _ - only')
	});
	if (!user) return undefined;
	await state.update(storageKey, user.trim());
	return user.trim();
}

/** Adds the ssh config block after showing it. Returns the alias to connect with, or `undefined` when the user connects without it. `false` means cancel. */
async function offerConfigEntry(location: VmLocation, target: SshTarget, user: string): Promise<string | undefined | false> {
	const key = vmKey(location);
	const alias = hostAlias(location.vm.name, key);
	const block = renderSshConfigBlock(key, { alias, host: target.host, port: target.port, user, vmName: location.vm.name });
	const file = sshConfigPath();
	const current = readSshConfig(file);
	const existing = findSshConfigBlock(current, key);
	if (existing === block) return alias;
	const choice = await vscode.window.showInformationMessage(
		`${existing ? 'Update' : 'Add'} "${alias}" in your ssh config?`,
		{
			modal: true,
			detail: `${file}\n\nThis block is ${existing ? 'replaced' : 'appended'}; the rest of the file is not touched (a copy is kept once as config.vmm.bak):\n\n${block}\n\nIt lets Remote-SSH and ssh call this machine "${alias}", and keeps its host key apart from other machines that use the same forwarded port. Choose Connect Without to use the address directly.`
		},
		'Add and Connect',
		'Connect Without'
	);
	if (!choice) return false;
	if (choice === 'Connect Without') return undefined;
	writeSshConfig(file, current, upsertSshConfigBlock(current, key, block));
	log.info(`Wrote ssh config entry ${alias} to ${file}`);
	return alias;
}

/** Forwards a port on this computer to port 22 of the guest. Returns whether an SSH forward exists afterwards. */
export async function addSshForward(manager: ConnectionManager, location: VmLocation): Promise<boolean> {
	try {
		const connection = await manager.connect(location.ref.clusterId);
		if (!connection.addPortForward || !connection.getVmDetails) throw new Error('This hypervisor cannot forward ports');
		const details = await connection.getVmDetails(location.ref.nodeId, location.ref.vmId);
		const existing = details.forwards.find((f) => f.protocol === 'tcp' && f.guestPort === 22);
		if (existing) {
			void vscode.window.showInformationMessage(`"${location.vm.name}" already forwards ${connectAddress(existing)}:${existing.hostPort} to SSH.`);
			return true;
		}
		const suggested = await findFreePort(2222, details.forwards.map((f) => f.hostPort));
		const answer = await vscode.window.showInputBox({
			title: `Forward SSH of ${location.vm.name}`,
			prompt: 'Port on this computer that reaches port 22 of the guest',
			value: String(suggested),
			validateInput: (value) => (/^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535 ? undefined : 'A port from 1024 to 65535')
		});
		if (!answer) return false;
		await connection.addPortForward(location.ref.nodeId, location.ref.vmId, { protocol: 'tcp', hostPort: Number(answer), guestPort: 22 });
		await manager.refresh(location.ref.clusterId);
		void vscode.window.setStatusBarMessage(`Forwarded 127.0.0.1:${answer} to SSH of ${location.vm.name}`, 4000);
		return true;
	} catch (error) {
		await showError(`Could not forward SSH for ${location.vm.name}`, error);
		return false;
	}
}

/**
 * Opens the VM in a Remote - SSH window. Finds the way in (an SSH port forward, else an address the host can
 * reach), checks that an SSH server answers, and offers an ssh config entry first, never writing silently.
 */
export async function connectSsh(manager: ConnectionManager, state: vscode.Memento, location: VmLocation): Promise<void> {
	const { ref, vm } = location;
	if (vm.state !== 'running') {
		const choice = await vscode.window.showInformationMessage(`"${vm.name}" is not running.`, 'Start');
		if (choice === 'Start') await vscode.commands.executeCommand('vmm.start', ref);
		return;
	}
	try {
		const connection = await manager.connect(ref.clusterId);
		if (!connection.getVmDetails) throw new Error('This hypervisor does not report where the machine can be reached');
		let details = await connection.getVmDetails(ref.nodeId, ref.vmId);
		let target = chooseSshTarget(details);
		if (!target) {
			if (!connection.addPortForward) {
				void vscode.window.showWarningMessage(`No address is known for "${vm.name}". Its network adapter reports none (a guest agent usually provides it).`);
				return;
			}
			const choice = await vscode.window.showInformationMessage(
				`"${vm.name}" has no route for SSH from this computer. Forward a port here to port 22 of the guest?`,
				'Add Forward'
			);
			if (choice !== 'Add Forward' || !(await addSshForward(manager, location))) return;
			details = await connection.getVmDetails(ref.nodeId, ref.vmId);
			target = chooseSshTarget(details);
			if (!target) return;
		}
		const found = target;
		const copyCommand = (user: string) => {
			const forward = details.forwards.find((f) => f.protocol === 'tcp' && f.guestPort === 22);
			const base = forward && found.via === 'forward' ? sshCommand(forward) : `ssh ${found.host}`;
			return `${base?.replace(/^ssh /, `ssh -l ${user} `)}`;
		};

		if (!vscode.extensions.getExtension(REMOTE_SSH_ID)) {
			const choice = await vscode.window.showInformationMessage('Connecting needs the "Remote - SSH" extension.', 'Install', 'Copy ssh Command');
			if (choice === 'Install') {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', REMOTE_SSH_ID);
				void vscode.window.showInformationMessage('Remote - SSH is installed. Run Connect with Remote-SSH again.');
			} else if (choice === 'Copy ssh Command') {
				const user = await sshUser(state, location);
				if (user) await vscode.env.clipboard.writeText(copyCommand(user));
			}
			return;
		}

		const user = await sshUser(state, location);
		if (!user) return;

		const probe = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Checking SSH on ${found.host}:${found.port}…` },
			() => probeSsh(found.host, found.port)
		);
		if (!probe.ok) {
			const choice = await vscode.window.showWarningMessage(describeProbe(probe, found), 'Connect Anyway', 'Copy ssh Command');
			if (choice === 'Copy ssh Command') await vscode.env.clipboard.writeText(copyCommand(user));
			if (choice !== 'Connect Anyway') return;
		}

		let alias: string | undefined;
		if (vscode.workspace.getConfiguration('vmm.ssh').get<boolean>('addConfigEntry', true)) {
			const offered = await offerConfigEntry(location, found, user);
			if (offered === false) return;
			alias = offered;
		}
		await vscode.commands.executeCommand(OPEN_COMMAND, alias ? { host: alias } : { host: found.host, userName: user, port: found.port });
	} catch (error) {
		await showError(`Could not connect to ${vm.name} over SSH`, error);
	}
}

/**
 * Lets the user choose which machines get an entry in the ssh config, so they can be reached with plain
 * `ssh <alias>` and appear in Remote - SSH's host list without opening each one from here first.
 */
export async function addToSshConfig(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
	try {
		const file = sshConfigPath();
		const candidates = manager.allVms().filter((l) => l.cluster.connection?.capabilities.details);
		const routes = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Looking for SSH routes…' },
			async () => {
				const found: Array<{ location: VmLocation; target: SshTarget }> = [];
				for (const location of candidates) {
					try {
						const details = await (await manager.connect(location.ref.clusterId)).getVmDetails?.(location.ref.nodeId, location.ref.vmId);
						const target = details && chooseSshTarget(details);
						if (target) found.push({ location, target });
					} catch (error) {
						log.warn(`SSH route of ${location.vm.name}: ${(error as Error).message}`);
					}
				}
				return found;
			}
		);
		if (!routes.length) {
			void vscode.window.showInformationMessage('None of your machines has an SSH route yet. Use "VM: Forward SSH Port…" to give one a port on this computer.');
			return;
		}
		const current = readSshConfig(file);
		const listed = new Map(listSshConfigBlocks(current).map((b) => [b.key, b]));
		const items = routes.map(({ location, target }) => {
			const known = listed.get(vmKey(location));
			const upToDate = known && known.host === target.host && known.port === target.port;
			return {
				label: location.vm.name,
				description: `${location.cluster.cluster.name} › ${location.node.name}`,
				detail: `${target.host}:${target.port} (${target.via === 'forward' ? 'port forward' : 'network address'})${known ? (upToDate ? ' · already in the ssh config' : ' · in the ssh config, address changed') : ''}`,
				picked: !upToDate,
				location,
				target
			};
		});
		const chosen = await vscode.window.showQuickPick(items, {
			canPickMany: true,
			title: 'Add machines to the ssh config',
			placeHolder: `Choose the machines to add to ${file}${routes.length < candidates.length ? ` (${candidates.length - routes.length} without an SSH route are not listed)` : ''}`,
			matchOnDescription: true,
			matchOnDetail: true
		});
		if (!chosen?.length) return;

		// One question for the machines that have no remembered account.
		let fallbackUser: string | undefined;
		const users = new Map<string, string>();
		for (const { location } of chosen) {
			const remembered = state.get<string>(`vmm.sshUser.${vmKey(location)}`);
			if (remembered) {
				users.set(vmKey(location), remembered);
				continue;
			}
			fallbackUser ??= await vscode.window.showInputBox({
				title: 'SSH user for the new entries',
				prompt: 'The account to sign in as inside the guests that have none remembered yet.',
				value: vscode.workspace.getConfiguration('vmm.ssh').get<string>('user', '').trim() || os.userInfo().username,
				validateInput: (value) => (validSshUser(value.trim()) ? undefined : 'Letters, digits, . _ - only')
			});
			if (!fallbackUser) return;
			users.set(vmKey(location), fallbackUser.trim());
			await state.update(`vmm.sshUser.${vmKey(location)}`, fallbackUser.trim());
		}

		let next = current;
		const blocks: string[] = [];
		for (const { location, target } of chosen) {
			const key = vmKey(location);
			const block = renderSshConfigBlock(key, {
				alias: hostAlias(location.vm.name, key),
				host: target.host,
				port: target.port,
				user: users.get(key)!,
				vmName: location.vm.name
			});
			blocks.push(block);
			next = upsertSshConfigBlock(next, key, block);
		}
		const changed = blocks.filter((block, index) => findSshConfigBlock(current, vmKey(chosen[index]!.location)) !== block);
		if (!changed.length) {
			void vscode.window.showInformationMessage('The ssh config already has these machines.');
			return;
		}
		const confirm = await vscode.window.showInformationMessage(
			`Write ${changed.length} ${changed.length === 1 ? 'entry' : 'entries'} to your ssh config?`,
			{
				modal: true,
				detail: `${file}\n\nOnly these blocks are added or replaced; the rest of the file is not touched (a copy is kept once as config.vmm.bak):\n\n${previewBlocks(changed)}`
			},
			'Write'
		);
		if (confirm !== 'Write') return;
		writeSshConfig(file, current, next);
		log.info(`Wrote ${changed.length} ssh config entries to ${file}`);
		const choice = await vscode.window.showInformationMessage(
			`Added ${changed.length} ${changed.length === 1 ? 'machine' : 'machines'} to the ssh config. Use \`ssh <name>\` or Remote-SSH: Connect to Host.`,
			'Open Config'
		);
		if (choice === 'Open Config') await vscode.window.showTextDocument(vscode.Uri.file(file));
	} catch (error) {
		await showError('Could not update the ssh config', error);
	}
}

/** Lets the user choose which VM Manager entries to take out of the ssh config again. */
export async function removeFromSshConfig(): Promise<void> {
	try {
		const file = sshConfigPath();
		const current = readSshConfig(file);
		const blocks = listSshConfigBlocks(current);
		if (!blocks.length) {
			void vscode.window.showInformationMessage(`${file} has no entries written by VM Manager.`);
			return;
		}
		const chosen = await vscode.window.showQuickPick(
			blocks.map((b) => ({ label: b.alias ?? b.key, description: b.name, detail: `${b.user ?? '?'}@${b.host ?? '?'}:${b.port ?? '?'}`, block: b })),
			{ canPickMany: true, title: 'Remove machines from the ssh config', placeHolder: `Entries written by VM Manager in ${file}`, matchOnDescription: true, matchOnDetail: true }
		);
		if (!chosen?.length) return;
		const confirm = await vscode.window.showWarningMessage(
			`Remove ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'} from your ssh config?`,
			{
				modal: true,
				detail: `${file}\n\nOnly these blocks are removed (a copy is kept once as config.vmm.bak):\n\n${chosen.map((c) => `• ${c.label}${c.description ? ` (${c.description})` : ''}`).join('\n')}`
			},
			'Remove'
		);
		if (confirm !== 'Remove') return;
		let next = current;
		for (const { block } of chosen) next = removeSshConfigBlock(next, block.key);
		writeSshConfig(file, current, next);
		log.info(`Removed ${chosen.length} ssh config entries from ${file}`);
		void vscode.window.setStatusBarMessage(`Removed ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'} from the ssh config`, 4000);
	} catch (error) {
		await showError('Could not update the ssh config', error);
	}
}
