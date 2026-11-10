import * as vscode from 'vscode';
import type { Snapshot } from '@vmm/sdk';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import { errorMessage, showError } from '../util/log';

/**
 * The user-facing parts of snapshots, shared by the commands (tree, overview, palette) and the
 * details page, so a revert asks the same questions wherever it starts.
 */

/** `2026-11-10 07-20`: a name every provider accepts (no colons) that sorts by time. */
export function defaultSnapshotName(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

async function connection(manager: ConnectionManager, location: VmLocation) {
	const conn = await manager.connect(location.ref.clusterId);
	if (!conn.listSnapshots || !conn.createSnapshot || !conn.revertSnapshot || !conn.deleteSnapshot) {
		throw new Error('This hypervisor does not support snapshots');
	}
	return conn as typeof conn & Required<Pick<typeof conn, 'listSnapshots' | 'createSnapshot' | 'revertSnapshot' | 'deleteSnapshot'>>;
}

export async function listSnapshots(manager: ConnectionManager, location: VmLocation): Promise<Snapshot[]> {
	return (await connection(manager, location)).listSnapshots(location.ref.nodeId, location.ref.vmId);
}

/** Asks for a name when none is given. Returns the snapshot, or `undefined` if the user cancelled or it failed (already reported). */
export async function takeSnapshot(manager: ConnectionManager, location: VmLocation, name?: string): Promise<Snapshot | undefined> {
	const running = location.vm.state !== 'stopped';
	if (name === undefined) {
		name = await vscode.window.showInputBox({
			title: `Take a snapshot of ${location.vm.name}`,
			prompt: running
				? 'The machine is running: the snapshot captures its disks as they are right now, like a power cut. Memory is not saved.'
				: 'Name for the snapshot',
			value: defaultSnapshotName()
		});
		if (name === undefined) return undefined;
	}
	try {
		const conn = await connection(manager, location);
		const snapshot = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Taking a snapshot of ${location.vm.name}…` },
			() => conn.createSnapshot(location.ref.nodeId, location.ref.vmId, name.trim())
		);
		await manager.refresh(location.ref.clusterId);
		void vscode.window.setStatusBarMessage(`Snapshot "${snapshot.name}" taken of ${location.vm.name}`, 4000);
		return snapshot;
	} catch (error) {
		await showError(`Could not take a snapshot of ${location.vm.name}`, error);
		return undefined;
	}
}

/**
 * Reverts after a modal confirmation. When the hypervisor needs the VM stopped, the confirmation
 * says so and the VM is powered off first (the revert discards its state anyway).
 */
export async function revertSnapshot(manager: ConnectionManager, location: VmLocation, snapshot: Snapshot): Promise<boolean> {
	const needsStop = !!location.cluster.connection?.capabilities.snapshotRevertNeedsStopped && location.vm.state !== 'stopped';
	const detail = [
		`Everything changed in "${location.vm.name}" since this snapshot is lost${snapshot.createdAt ? ` (taken ${new Date(snapshot.createdAt).toLocaleString()})` : ''}.`,
		needsStop ? 'The machine is running and will be powered off first, like pulling the power plug.' : undefined,
		snapshot.includesMemory ? undefined : 'The snapshot holds disk state only, so the machine starts fresh from that disk state.'
	]
		.filter(Boolean)
		.join('\n\n');
	const choice = await vscode.window.showWarningMessage(`Revert "${location.vm.name}" to "${snapshot.name}"?`, { modal: true, detail }, needsStop ? 'Power Off and Revert' : 'Revert');
	if (!choice) return false;
	try {
		const conn = await connection(manager, location);
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reverting ${location.vm.name} to "${snapshot.name}"…` }, async () => {
			if (needsStop) await manager.power(location.ref, 'stop');
			await conn.revertSnapshot(location.ref.nodeId, location.ref.vmId, snapshot.id);
		});
		await manager.refresh(location.ref.clusterId);
		void vscode.window.setStatusBarMessage(`${location.vm.name} reverted to "${snapshot.name}"`, 4000);
		return true;
	} catch (error) {
		await showError(`Could not revert ${location.vm.name} to "${snapshot.name}"`, error);
		return false;
	}
}

export async function deleteSnapshot(manager: ConnectionManager, location: VmLocation, snapshot: Snapshot): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(`Delete snapshot "${snapshot.name}"?`, { modal: true, detail: `It is removed from "${location.vm.name}". The machine itself is not changed.` }, 'Delete');
	if (!choice) return false;
	try {
		await (await connection(manager, location)).deleteSnapshot(location.ref.nodeId, location.ref.vmId, snapshot.id);
		await manager.refresh(location.ref.clusterId);
		return true;
	} catch (error) {
		await showError(`Could not delete the snapshot "${snapshot.name}"`, error);
		return false;
	}
}

/** Lets the user pick one of the VM's snapshots. */
export async function pickSnapshot(manager: ConnectionManager, location: VmLocation, placeholder: string): Promise<Snapshot | undefined> {
	let snapshots: Snapshot[];
	try {
		snapshots = await listSnapshots(manager, location);
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not list the snapshots of ${location.vm.name}: ${errorMessage(error)}`);
		return undefined;
	}
	if (!snapshots.length) {
		void vscode.window.showInformationMessage(`${location.vm.name} has no snapshots.`);
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		[...snapshots].reverse().map((snapshot) => ({
			label: snapshot.name,
			description: snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : undefined,
			detail: snapshot.includesMemory ? 'Includes memory' : 'Disk state only',
			snapshot
		})),
		{ placeHolder: placeholder }
	);
	return picked?.snapshot;
}
