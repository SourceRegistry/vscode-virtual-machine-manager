import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ClusterConnection, DiskDevice, DiskImageFormat, DiskProgress } from '@vmm/sdk';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import type { VmActivity } from '../activity/VmActivity';
import { showError } from '../util/log';
import { formatBytes } from '../../shared/metrics';
import { diskDescription, diskOperations, diskSizePreview, diskSizeProblem, EXPORT_CHOICES, exportFileName, needsStopText, parseDiskSize, type ExportChoice } from '../../shared/disks';

/**
 * "Disks…": add, grow, convert, export and remove a VM's disks, in quick picks. Offers only what the provider
 * can do in the VM's current state; what needs the VM shut down is named in the placeholder instead.
 */

export interface DiskFlowDeps {
	manager: ConnectionManager;
	activity: VmActivity;
}

type Action = { label: string; description?: string; run: () => Promise<void> };

export async function manageDisks(deps: DiskFlowDeps, location: VmLocation, diskId?: string): Promise<void> {
	const { manager } = deps;
	const vmName = location.vm.name;
	let connection: ClusterConnection;
	let disks: DiskDevice[];
	try {
		connection = await manager.connect(location.ref.clusterId);
		if (!connection.getVmDetails) throw new Error('This hypervisor does not list the disks of a machine');
		disks = (await connection.getVmDetails(location.ref.nodeId, location.ref.vmId)).disks.filter((d) => d.kind === 'disk');
	} catch (error) {
		await showError(`Could not read the disks of ${vmName}`, error);
		return;
	}
	const running = location.vm.state !== 'stopped';
	const { now, needsStop } = diskOperations(connection, running);
	const stopNote = needsStopText(vmName, needsStop);

	// `new`: straight to adding one (the dashboard's + button).
	const canAdd = now.has('add') && !!connection.addDisk;
	const canAttach = now.has('attach') && !!connection.attachDisk;
	if (diskId === 'new' && (canAdd || canAttach)) return addDisk(deps, location, connection, canAdd, canAttach);
	let disk = diskId ? disks.find((d) => d.id === diskId) : undefined;
	if (!disk) {
		type Item = vscode.QuickPickItem & { disk?: DiskDevice; add?: boolean };
		const items: Item[] = [
			...(canAdd || canAttach ? [{ label: '$(add) Add Disk…', description: canAttach ? (canAdd ? 'A new, empty disk or an image file' : 'An image file') : 'A new, empty disk', add: true }] : []),
			...disks.map((d) => ({ label: `$(database) ${d.label}`, description: diskDescription(d), detail: d.path, disk: d }))
		];
		if (!items.length) {
			void vscode.window.showInformationMessage(stopNote ?? `${vmName} has no disks.`);
			return;
		}
		const picked = await vscode.window.showQuickPick(items, { title: `Disks of ${vmName}`, placeHolder: stopNote ?? 'Select a disk, or add one' });
		if (!picked) return;
		if (picked.add) return addDisk(deps, location, connection, canAdd, canAttach);
		disk = picked.disk!;
	}

	const chosen = disk;
	const actions: Action[] = [];
	if (now.has('resize') && connection.resizeDisk) {
		actions.push({ label: '$(arrow-both) Grow…', description: 'Make the disk larger', run: () => growDisk(deps, location, connection, chosen, actions.length === 1 ? stopNote : undefined) });
	}
	if (now.has('convert') && connection.convertDisk) {
		if (chosen.format === 'qcow2') actions.push({ label: '$(fold) Compact', description: 'Give space the guest freed back to the host', run: () => convertDisk(deps, location, connection, chosen, 'qcow2') });
		if (chosen.format !== 'qcow2') actions.push({ label: '$(sync) Convert to qcow2', description: 'Grows as the guest writes; allows snapshots', run: () => convertDisk(deps, location, connection, chosen, 'qcow2') });
		if (chosen.format !== 'raw') actions.push({ label: '$(sync) Convert to raw', description: 'A plain image of the full size', run: () => convertDisk(deps, location, connection, chosen, 'raw') });
	}
	if (now.has('export') && connection.exportDisk) {
		actions.push({ label: '$(export) Export…', description: 'Save a copy as qcow2, raw, VMDK, VHDX or VDI', run: () => exportDisk(deps, location, connection, chosen) });
	}
	if (now.has('remove') && connection.removeDisk) {
		actions.push({ label: '$(trash) Remove…', description: 'Detach it from the machine', run: () => removeDisk(deps, location, connection, chosen, disks) });
	}
	if (!actions.length) {
		void vscode.window.showInformationMessage(stopNote ?? `Nothing can be done to ${chosen.label} here.`);
		return;
	}
	// One thing to do is no choice: go straight to it (the form names what waits for a shut down).
	if (actions.length === 1) return actions[0]!.run();
	const action = await vscode.window.showQuickPick(actions, { title: `${chosen.label} of ${vmName} (${diskDescription(chosen)})`, placeHolder: stopNote ?? 'What do you want to do?' });
	await action?.run();
}

async function done(deps: DiskFlowDeps, location: VmLocation, record: string, status: string): Promise<void> {
	deps.activity.record(location.ref, record);
	await deps.manager.refresh(location.ref.clusterId);
	void vscode.window.setStatusBarMessage(status, 4000);
}

function withDiskProgress<T>(title: string, task: (progress: (update: DiskProgress) => void) => Promise<T>): Thenable<T> {
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, (report) => {
		let reported = 0;
		return task((update) => {
			const fraction = update.fraction === undefined ? undefined : Math.max(reported, Math.min(1, update.fraction));
			report.report({ message: update.message, increment: fraction === undefined ? undefined : (fraction - reported) * 100 });
			if (fraction !== undefined) reported = fraction;
		});
	});
}

/**
 * A size typed in VS Code's input box. The preview of what it comes to shows below it as the user types (an
 * informational message, so it does not block Enter).
 */
async function askSize(title: string, prompt: string, current?: number): Promise<number | undefined> {
	const text = await vscode.window.showInputBox({
		title,
		prompt,
		placeHolder: current === undefined ? 'e.g. 20 GB or 512 MB' : 'e.g. 40 GB, +10 GB or +512 MB',
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value.trim()) return undefined;
			const problem = diskSizeProblem(value, current);
			if (problem) return problem;
			return { message: diskSizePreview(value, current)!, severity: vscode.InputBoxValidationSeverity.Info };
		}
	});
	if (text === undefined || diskSizeProblem(text, current)) return undefined;
	return (parseDiskSize(text, current) as { bytes: number }).bytes;
}

async function addDisk(deps: DiskFlowDeps, location: VmLocation, connection: ClusterConnection, canAdd: boolean, canAttach: boolean): Promise<void> {
	let source: 'empty' | 'file' = canAdd ? 'empty' : 'file';
	if (canAdd && canAttach) {
		const picked = await vscode.window.showQuickPick(
			[
				{ label: '$(new-file) Empty disk', description: 'A new disk of the size you give', source: 'empty' as const },
				{ label: '$(file-symlink-file) Image file…', description: 'qcow2, raw, VMDK, VHDX, VHD or VDI', source: 'file' as const }
			],
			{ title: `Add a disk to ${location.vm.name}`, placeHolder: 'What should the new disk be?' }
		);
		if (!picked) return;
		source = picked.source;
	}
	return source === 'file' ? attachImage(deps, location, connection) : addEmptyDisk(deps, location, connection);
}

async function addEmptyDisk(deps: DiskFlowDeps, location: VmLocation, connection: ClusterConnection): Promise<void> {
	const vmName = location.vm.name;
	const bytes = await askSize(`Add a disk to ${vmName}`, 'Size of the new disk: MB, GB or TB (a plain number is GB)');
	if (bytes === undefined) return;
	const picked = await vscode.window.showQuickPick(
		[
			{ label: 'qcow2', description: 'Takes space as the guest writes; allows snapshots', format: 'qcow2' as const },
			{ label: 'raw', description: 'Takes its full size at once; a little faster', format: 'raw' as const }
		],
		{ title: `Add a ${formatBytes(bytes)} disk to ${vmName}`, placeHolder: 'Image format' }
	);
	if (!picked) return;
	const format = picked.format;
	try {
		const disk = await withDiskProgress(`Adding a disk to ${vmName}…`, () => connection.addDisk!(location.ref.nodeId, location.ref.vmId, { sizeBytes: bytes, format }));
		await done(deps, location, `Added ${disk.label} (${formatBytes(bytes)}, ${format})${disk.path ? `: ${disk.path}` : ''}`, `Added ${disk.label} to ${vmName}`);
		void vscode.window.showInformationMessage(`${disk.label} (${formatBytes(bytes)}) was added to ${vmName}. The guest sees an empty disk: partition and format it before use.`);
	} catch (error) {
		await showError(`Could not add a disk to ${vmName}`, error);
	}
}

async function attachImage(deps: DiskFlowDeps, location: VmLocation, connection: ClusterConnection): Promise<void> {
	const vmName = location.vm.name;
	const caps = connection.capabilities;
	let image: string | undefined;
	if (caps.remotePaths && !caps.diskAttachFromHere) {
		// The image lies on the host: this computer's file dialog cannot show it.
		image = (
			await vscode.window.showInputBox({
				title: `Attach a disk image to ${vmName}`,
				prompt: 'Path of the image on the host (qcow2, raw, VMDK, VHDX, VHD or VDI)',
				placeHolder: '/var/lib/images/disk.qcow2',
				ignoreFocusOut: true,
				validateInput: (value) => (!value.trim() || /^(\/|[A-Za-z]:[\\/])/.test(value.trim()) ? undefined : 'Give the full path on the host.')
			})
		)?.trim();
	} else {
		image = (
			await vscode.window.showOpenDialog({
				title: `Attach a disk image to ${vmName}`,
				canSelectMany: false,
				openLabel: 'Attach',
				filters: { 'Disk images': ['qcow2', 'img', 'raw', 'vmdk', 'vhdx', 'vhd', 'vdi', 'qcow'], 'All files': ['*'] }
			})
		)?.[0]?.fsPath;
	}
	if (!image) return;
	const modes = caps.diskAttachModes ?? ['copy'];
	let copy = modes[0] === 'copy';
	if (modes.length > 1) {
		const picked = await vscode.window.showQuickPick(
			[
				{ label: '$(copy) Copy it', description: "Next to the machine's disks; the original stays as it is", copy: true },
				{ label: '$(link) Use it where it is', description: 'The machine writes to this file', copy: false }
			],
			{ title: `Attach ${path.basename(image)} to ${vmName}`, placeHolder: image }
		);
		if (!picked) return;
		copy = picked.copy;
	}
	try {
		const disk = await withDiskProgress(`Attaching ${path.basename(image)} to ${vmName}…`, (progress) =>
			connection.attachDisk!(location.ref.nodeId, location.ref.vmId, image, { copy }, progress)
		);
		await done(deps, location, `Attached ${image}${copy ? ` as a copy${disk.path ? ` (${disk.path})` : ''}` : ''} as ${disk.label}`, `Attached ${path.basename(image)} to ${vmName}`);
	} catch (error) {
		await showError(`Could not attach ${path.basename(image)} to ${vmName}`, error);
	}
}

async function growDisk(deps: DiskFlowDeps, location: VmLocation, connection: ClusterConnection, disk: DiskDevice, note?: string): Promise<void> {
	const vmName = location.vm.name;
	const current = disk.sizeBytes;
	const bytes = await askSize(
		`Grow ${disk.label} of ${vmName}`,
		`${current !== undefined ? `Now ${formatBytes(current)}. ` : ''}Type the new size, or + and how much more (MB, GB or TB). Disks cannot shrink.${note ? ` ${note}` : ''}`,
		current
	);
	if (bytes === undefined) return;
	try {
		await withDiskProgress(`Growing ${disk.label} of ${vmName}…`, () => connection.resizeDisk!(location.ref.nodeId, location.ref.vmId, disk.id, bytes));
		await done(deps, location, `Grew ${disk.label} from ${formatBytes(current)} to ${formatBytes(bytes)}`, `${disk.label} of ${vmName} is now ${formatBytes(bytes)}`);
		void vscode.window.showInformationMessage(
			`${disk.label} of ${vmName} is now ${formatBytes(bytes)}. Grow the partition and file system inside the guest to use the space (Linux: growpart and resize2fs; Windows: Disk Management, Extend Volume).`
		);
	} catch (error) {
		await showError(`Could not grow ${disk.label} of ${vmName}`, error);
	}
}

async function convertDisk(deps: DiskFlowDeps, location: VmLocation, connection: ClusterConnection, disk: DiskDevice, format: 'qcow2' | 'raw'): Promise<void> {
	const vmName = location.vm.name;
	const compact = disk.format === format;
	const choice = await vscode.window.showWarningMessage(
		compact ? `Compact ${disk.label} of ${vmName}?` : `Convert ${disk.label} of ${vmName} to ${format}?`,
		{
			modal: true,
			detail: [
				compact
					? 'The image is copied without the blocks the guest no longer uses (zeroed or trimmed), and the copy replaces it.'
					: `The image is copied as ${format}, the copy takes its place in the machine and the old file is deleted.`,
				`This needs free space on the host for the copy${disk.sizeBytes !== undefined ? ` (up to ${formatBytes(disk.sizeBytes)})` : ''} and can take a while.`
			].join('\n\n')
		},
		compact ? 'Compact' : 'Convert'
	);
	if (!choice) return;
	try {
		await withDiskProgress(compact ? `Compacting ${disk.label} of ${vmName}…` : `Converting ${disk.label} of ${vmName} to ${format}…`, (progress) =>
			connection.convertDisk!(location.ref.nodeId, location.ref.vmId, disk.id, format, progress)
		);
		const after = (await connection.getVmDetails?.(location.ref.nodeId, location.ref.vmId).catch(() => undefined))?.disks.find((d) => d.id === disk.id);
		const saved = disk.allocatedBytes !== undefined && after?.allocatedBytes !== undefined ? disk.allocatedBytes - after.allocatedBytes : undefined;
		const result = saved !== undefined ? ` (${formatBytes(after!.allocatedBytes)} on the host${saved > 0 ? `, ${formatBytes(saved)} less` : ''})` : '';
		await done(deps, location, compact ? `Compacted ${disk.label}${result}` : `Converted ${disk.label} to ${format}${result}`, compact ? `Compacted ${disk.label}${result}` : `Converted ${disk.label} to ${format}`);
	} catch (error) {
		await showError(compact ? `Could not compact ${disk.label} of ${vmName}` : `Could not convert ${disk.label} of ${vmName}`, error);
	}
}

async function exportDisk(deps: DiskFlowDeps, location: VmLocation, connection: ClusterConnection, disk: DiskDevice): Promise<void> {
	const vmName = location.vm.name;
	const caps = connection.capabilities;
	let choice: ExportChoice | undefined;
	if (caps.diskExportConverts) {
		choice = await vscode.window.showQuickPick(EXPORT_CHOICES, { title: `Export ${disk.label} of ${vmName}`, placeHolder: 'Format of the copy' });
	} else {
		// The provider copies the image as it is.
		const format = (disk.format ?? 'raw') as DiskImageFormat;
		choice = EXPORT_CHOICES.find((c) => c.format === format && !c.compress) ?? { label: format, description: '', format, extension: format };
	}
	if (!choice) return;
	const fileName = exportFileName(vmName, disk.label, choice.extension);
	let target: string | undefined;
	if (caps.remotePaths && !caps.diskExportsHere) {
		// The copy is written on the host: this computer's save dialog cannot show it.
		const folder = disk.path ? path.posix.dirname(disk.path.replace(/\\/g, '/')) : '';
		target = (
			await vscode.window.showInputBox({
				title: `Export ${disk.label} of ${vmName}`,
				prompt: 'Path of the copy on the host',
				value: folder ? `${folder}/${fileName}` : fileName,
				ignoreFocusOut: true,
				validateInput: (value) => (/^(\/|[A-Za-z]:[\\/])/.test(value.trim()) ? undefined : 'Give an absolute path on the host.')
			})
		)?.trim();
	} else {
		const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		target = (
			await vscode.window.showSaveDialog({
				title: `Export ${disk.label} of ${vmName}`,
				defaultUri: vscode.Uri.file(path.join(base, fileName)),
				filters: { [`${choice.label} image`]: [choice.extension] },
				saveLabel: 'Export'
			})
		)?.fsPath;
	}
	if (!target) return;
	try {
		await withDiskProgress(`Exporting ${disk.label} of ${vmName}…`, (progress) =>
			connection.exportDisk!(location.ref.nodeId, location.ref.vmId, disk.id, target, { format: choice.format, compress: choice.compress }, progress)
		);
		deps.activity.record(location.ref, `Exported ${disk.label} as ${choice.label} to ${target}`);
		const here = !caps.remotePaths || caps.diskExportsHere;
		const reveal = here ? await vscode.window.showInformationMessage(`${disk.label} of ${vmName} was exported to ${target}.`, 'Reveal in File Explorer') : undefined;
		if (!here) void vscode.window.showInformationMessage(`${disk.label} of ${vmName} was exported to ${target} on the host.`);
		if (reveal) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
	} catch (error) {
		await showError(`Could not export ${disk.label} of ${vmName}`, error);
	}
}

async function removeDisk(deps: DiskFlowDeps, location: VmLocation, connection: ClusterConnection, disk: DiskDevice, disks: DiskDevice[]): Promise<void> {
	const vmName = location.vm.name;
	const first = disks[0]?.id === disk.id;
	const keep = 'Remove, Keep File';
	const remove = 'Remove and Delete File';
	const choice = await vscode.window.showWarningMessage(
		`Remove ${disk.label} from ${vmName}?`,
		{
			modal: true,
			detail: [
				disk.path ? `${disk.path}${disk.sizeBytes !== undefined ? ` (${formatBytes(disk.sizeBytes)})` : ''}` : undefined,
				first ? 'This is the first disk: the machine probably starts from it and will not boot without it.' : undefined,
				'Keep the file to attach or copy it later, or delete it with everything on it.'
			]
				.filter(Boolean)
				.join('\n\n')
		},
		keep,
		remove
	);
	if (!choice) return;
	const deleteFile = choice === remove;
	try {
		await connection.removeDisk!(location.ref.nodeId, location.ref.vmId, disk.id, { deleteFile });
		await done(
			deps,
			location,
			`Removed ${disk.label}${disk.path ? ` (${disk.path})` : ''}${deleteFile ? ' and deleted its file' : ', file kept'}`,
			`Removed ${disk.label} from ${vmName}`
		);
	} catch (error) {
		await showError(`Could not remove ${disk.label} from ${vmName}`, error);
	}
}
