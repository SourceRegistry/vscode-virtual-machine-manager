import { Duplex, PassThrough } from 'node:stream';
import * as vscode from 'vscode';
import {
	ProviderError,
	type Capabilities,
	type ClusterConnection,
	type DiskDevice,
	type DiskExportOptions,
	type DiskProgress,
	type NewDisk,
	type VmDetails,
	type FieldSchema,
	type FieldValues,
	type GuestCommand,
	type GuestCommandResult,
	type HypervisorProvider,
	type PreviewFrame,
	type TransferProgress,
	type VmInfo
} from '@vmm/sdk';

/**
 * In-memory provider, registered only in development mode. Lets the UI be exercised without
 * a hypervisor: power transitions, create/edit/delete, a serial echo shell and a preview.
 */
export class FakeProvider implements HypervisorProvider {
	readonly id = 'fake';
	readonly displayName = 'Fake (development)';
	readonly icon = 'beaker';
	readonly connectionSchema: FieldSchema[] = [
		{ key: 'nodes', label: 'Number of nodes', type: 'number', default: 2, min: 1, max: 5 },
		{ key: 'token', label: 'API token', type: 'password', secret: true, description: 'Any value — exercises SecretStorage' }
	];

	defaultClusterName(): string {
		return 'Fake Lab';
	}

	async connect(cluster: { config: FieldValues }): Promise<ClusterConnection> {
		return new FakeConnection(Number(cluster.config.nodes ?? 2));
	}
}

const vmSchema = (): FieldSchema[] => [
	{ key: 'name', label: 'Name', type: 'text', required: true, group: 'General' },
	{ key: 'cpus', label: 'Processors', type: 'number', min: 1, max: 32, default: 2, unit: 'cores', group: 'Hardware' },
	{ key: 'memoryMB', label: 'Memory', type: 'number', min: 128, default: 2048, unit: 'MB', group: 'Hardware' },
	{
		key: 'os',
		label: 'Operating system',
		type: 'select',
		default: 'linux',
		group: 'General',
		options: [
			{ value: 'linux', label: 'Linux' },
			{ value: 'windows', label: 'Windows' }
		]
	},
	{ key: 'iso', label: 'Installation ISO', type: 'file', filters: { 'Disk images': ['iso'] }, group: 'Media', advanced: true },
	{ key: 'autostart', label: 'Start with host', type: 'checkbox', default: false, group: 'General', advanced: true }
];

const GB = 1024 ** 3;

class FakeConnection implements ClusterConnection {
	readonly capabilities: Capabilities = {
		create: true,
		edit: true,
		delete: true,
		power: ['start', 'shutdown', 'reboot', 'stop'],
		consoles: ['serial'],
		preview: true,
		external: false,
		guestExec: true,
		guestFiles: true,
		details: true,
		diskOperations: ['add', 'attach', 'remove', 'resize', 'convert', 'export'],
		diskOperationsWhileRunning: ['add', 'remove', 'resize'],
		diskExportConverts: true,
		diskAttachModes: ['copy', 'reference'],
		shutdownTimeoutSeconds: 20
	};
	/** Disks of the fake machines, by VM id. */
	private readonly disks = new Map<string, DiskDevice[]>();
	/** Files "in" the fake guests, by VM id and path. */
	private readonly guestFiles = new Map<string, Buffer>();
	private readonly emitter = new vscode.EventEmitter<{ vmId?: string }>();
	readonly onDidChange = this.emitter.event;
	private readonly vms = new Map<string, VmInfo & { nodeId: string; started?: number; values: FieldValues }>();
	private counter = 0;

	constructor(private readonly nodeCount: number) {
		for (let n = 0; n < nodeCount; n++) {
			for (let i = 0; i < 3; i++) this.add(`node-${n + 1}`, { name: `vm-${n + 1}${String.fromCharCode(97 + i)}`, cpus: 2, memoryMB: 2048, os: 'linux' }, i === 0);
		}
	}

	private running(vmId: string): void {
		const vm = this.vms.get(vmId);
		if (!vm) throw new ProviderError('No such VM', 'notFound');
		if (vm.state !== 'running') throw new ProviderError('Start the machine first.', 'invalid');
	}

	/** Echoes the command line, like a guest whose shell only knows `echo`. */
	async runInGuest(_nodeId: string, vmId: string, command: GuestCommand): Promise<GuestCommandResult> {
		this.running(vmId);
		await new Promise((r) => setTimeout(r, 300));
		const line = [command.command, ...(command.args ?? [])].join(' ');
		return { stdout: `fake guest ran: ${line}\n`, stderr: '', exitCode: 0, truncated: false, timedOut: false };
	}

	async copyToGuest(_nodeId: string, vmId: string, localPath: string, guestPath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
		this.running(vmId);
		const data = await vscode.workspace.fs.readFile(vscode.Uri.file(localPath));
		onProgress?.({ done: data.length, total: data.length });
		this.guestFiles.set(`${vmId}:${guestPath}`, Buffer.from(data));
	}

	async copyFromGuest(_nodeId: string, vmId: string, guestPath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
		this.running(vmId);
		const data = this.guestFiles.get(`${vmId}:${guestPath}`) ?? Buffer.from(`fake contents of ${guestPath}\n`);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(localPath), data);
		onProgress?.({ done: data.length, total: data.length });
	}

	private add(nodeId: string, values: FieldValues, running = false): VmInfo {
		const id = `fake-${++this.counter}`;
		const vm = {
			id,
			nodeId,
			name: String(values.name),
			state: running ? ('running' as const) : ('stopped' as const),
			cpus: Number(values.cpus ?? 1),
			memoryMB: Number(values.memoryMB ?? 1024),
			os: String(values.os ?? 'linux'),
			started: running ? Date.now() : undefined,
			ipAddresses: running ? [`10.0.0.${this.counter}`] : [],
			values
		};
		this.vms.set(id, vm);
		this.disks.set(id, [{ id: 'disk0', kind: 'disk', label: 'Hard disk 1', path: `/fake/${vm.name}/disk0.qcow2`, sizeBytes: 20 * GB, allocatedBytes: 3 * GB, format: 'qcow2', bus: 'virtio' }]);
		return vm;
	}

	async getVmDetails(_nodeId: string, vmId: string): Promise<VmDetails> {
		this.get(vmId);
		return { disks: [...(this.disks.get(vmId) ?? [])], nics: [], devices: [], forwards: [] };
	}

	private disk(vmId: string, diskId: string, stopped: boolean): { vm: ReturnType<FakeConnection['get']>; list: DiskDevice[]; disk: DiskDevice } {
		const vm = this.get(vmId);
		if (stopped && vm.state !== 'stopped') throw new ProviderError(`Shut down "${vm.name}" first.`, 'invalid');
		const list = this.disks.get(vmId) ?? [];
		const disk = list.find((d) => d.id === diskId);
		if (!disk) throw new ProviderError(`${vm.name} has no disk ${diskId}`, 'notFound');
		return { vm, list, disk };
	}

	async addDisk(_nodeId: string, vmId: string, disk: NewDisk): Promise<DiskDevice> {
		const vm = this.get(vmId);
		const list = this.disks.get(vmId) ?? [];
		let n = 0;
		while (list.some((d) => d.id === `disk${n}`)) n++;
		const format = disk.format ?? 'qcow2';
		const added: DiskDevice = { id: `disk${n}`, kind: 'disk', label: `Hard disk ${n + 1}`, path: `/fake/${vm.name}/disk${n}.${format === 'raw' ? 'img' : 'qcow2'}`, sizeBytes: disk.sizeBytes, allocatedBytes: format === 'raw' ? disk.sizeBytes : 196_608, format, bus: 'virtio' };
		this.disks.set(vmId, [...list, added]);
		this.emitter.fire({ vmId });
		return added;
	}

	async attachDisk(_nodeId: string, vmId: string, imagePath: string, options: { copy: boolean }): Promise<DiskDevice> {
		const vm = this.get(vmId);
		if (vm.state !== 'stopped') throw new ProviderError(`Shut down "${vm.name}" first.`, 'invalid');
		const data = await vscode.workspace.fs.stat(vscode.Uri.file(imagePath)).then(
			(stat) => stat,
			() => {
				throw new ProviderError(`Image not found: ${imagePath}`, 'invalid');
			}
		);
		const list = this.disks.get(vmId) ?? [];
		let n = 0;
		while (list.some((d) => d.id === `disk${n}`)) n++;
		const name = imagePath.split(/[\\/]/).pop()!;
		const attached: DiskDevice = { id: `disk${n}`, kind: 'disk', label: `Hard disk ${n + 1}`, path: options.copy ? `/fake/${vm.name}/disk${n}.qcow2` : imagePath, sizeBytes: Math.max(data.size, 1024 ** 2), allocatedBytes: data.size, format: options.copy ? 'qcow2' : (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? 'raw'), bus: 'virtio' };
		this.disks.set(vmId, [...list, attached]);
		this.emitter.fire({ vmId });
		return attached;
	}

	async removeDisk(_nodeId: string, vmId: string, diskId: string): Promise<void> {
		const { list } = this.disk(vmId, diskId, false);
		this.disks.set(vmId, list.filter((d) => d.id !== diskId));
		this.emitter.fire({ vmId });
	}

	async resizeDisk(_nodeId: string, vmId: string, diskId: string, sizeBytes: number): Promise<void> {
		const { disk } = this.disk(vmId, diskId, false);
		if (sizeBytes <= (disk.sizeBytes ?? 0)) throw new ProviderError('Disks can only grow.', 'invalid');
		disk.sizeBytes = sizeBytes;
		this.emitter.fire({ vmId });
	}

	async convertDisk(_nodeId: string, vmId: string, diskId: string, format: 'qcow2' | 'raw', progress?: (update: DiskProgress) => void): Promise<void> {
		const { disk } = this.disk(vmId, diskId, true);
		for (let step = 1; step <= 4; step++) {
			await new Promise((r) => setTimeout(r, 400));
			progress?.({ message: `Writing… ${step * 25}%`, fraction: step / 4 });
		}
		disk.allocatedBytes = format === 'raw' ? disk.sizeBytes : Math.round((disk.allocatedBytes ?? 0) * 0.7);
		disk.format = format;
		disk.path = disk.path?.replace(/\.[^.]+$/, format === 'raw' ? '.img' : '.qcow2');
		this.emitter.fire({ vmId });
	}

	async exportDisk(_nodeId: string, vmId: string, diskId: string, targetPath: string, options: DiskExportOptions, progress?: (update: DiskProgress) => void): Promise<void> {
		const { vm, disk } = this.disk(vmId, diskId, true);
		for (let step = 1; step <= 4; step++) {
			await new Promise((r) => setTimeout(r, 400));
			progress?.({ message: `Writing… ${step * 25}%`, fraction: step / 4 });
		}
		await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(`fake ${options.format}${options.compress ? ' (compressed)' : ''} export of ${disk.label} of ${vm.name}\n`));
	}

	private get(vmId: string) {
		const vm = this.vms.get(vmId);
		if (!vm) throw new ProviderError('VM not found', 'notFound');
		return vm;
	}

	async listNodes() {
		return Array.from({ length: this.nodeCount }, (_, i) => ({
			id: `node-${i + 1}`,
			name: `fake-node-${i + 1}`,
			status: 'online' as const,
			cpus: 16,
			memoryMB: 65536,
			memoryUsedMB: [...this.vms.values()].filter((v) => v.nodeId === `node-${i + 1}` && v.state === 'running').reduce((s, v) => s + (v.memoryMB ?? 0), 0)
		}));
	}

	async listVms(nodeId: string): Promise<VmInfo[]> {
		return [...this.vms.values()]
			.filter((v) => v.nodeId === nodeId)
			.map(({ nodeId: _n, started, values: _v, ...vm }) => ({
				...vm,
				uptimeSeconds: started ? Math.floor((Date.now() - started) / 1000) : undefined,
				// One machine plays an emulated guest, for the one-time notice.
				...(vm.id.endsWith('-2') ? { emulated: true } : {})
			}));
	}

	async readVmLog(_nodeId: string, vmId: string): Promise<string | undefined> {
		const vm = this.get(vmId);
		return `fake-hypervisor: ${vm.name} is ${vm.state}\nfake-hypervisor: nothing else to report\n`;
	}

	async getCreateSchema() {
		return vmSchema();
	}

	async createVm(nodeId: string, values: FieldValues) {
		return this.add(nodeId, values);
	}

	async getVmConfig(_nodeId: string, vmId: string) {
		const vm = this.get(vmId);
		return { schema: vmSchema(), values: { ...vm.values, name: vm.name, cpus: vm.cpus, memoryMB: vm.memoryMB } };
	}

	async updateVm(_nodeId: string, vmId: string, values: FieldValues) {
		const vm = this.get(vmId);
		vm.values = { ...vm.values, ...values };
		vm.name = String(values.name ?? vm.name);
		vm.cpus = Number(values.cpus ?? vm.cpus);
		vm.memoryMB = Number(values.memoryMB ?? vm.memoryMB);
	}

	async deleteVm(_nodeId: string, vmId: string) {
		this.get(vmId);
		this.vms.delete(vmId);
		this.disks.delete(vmId);
	}

	async power(_nodeId: string, vmId: string, action: string) {
		const vm = this.get(vmId);
		const transition = (via: VmInfo['state'], to: VmInfo['state']) => {
			vm.state = via;
			setTimeout(() => {
				vm.state = to;
				vm.started = to === 'running' ? Date.now() : undefined;
				vm.ipAddresses = to === 'running' ? [`10.0.0.${vmId.split('-')[1]}`] : [];
				this.emitter.fire({ vmId });
			}, 1500);
		};
		if (action === 'start') transition('starting', 'running');
		// A guest that takes its time, so the countdown shows.
		else if (action === 'shutdown') setTimeout(() => transition('stopping', 'stopped'), 6000);
		else if (action === 'reboot') transition('starting', 'running');
		else {
			vm.state = 'stopped';
			vm.started = undefined;
		}
	}

	async openConsole(_nodeId: string, vmId: string) {
		const vm = this.get(vmId);
		if (vm.state !== 'running') throw new ProviderError(`${vm.name} is not running`, 'unavailable');
		// A tiny line-editing echo "shell".
		const input = new PassThrough();
		const stream = new Duplex({
			read() {},
			write(chunk, _enc, cb) {
				input.write(chunk);
				cb();
			}
		});
		let line = '';
		const prompt = `\r\n${vm.name} login: root\r\n[root@${vm.name} ~]# `;
		setTimeout(() => stream.push(`Fake serial console for ${vm.name}${prompt}`), 100);
		input.on('data', (data: Buffer) => {
			for (const ch of data.toString('utf8')) {
				if (ch === '\r') {
					stream.push(`\r\n${line ? `${line}: command not found` : ''}${prompt.slice(prompt.lastIndexOf('['))}`);
					line = '';
				} else if (ch === '\x7f') {
					if (line) {
						line = line.slice(0, -1);
						stream.push('\b \b');
					}
				} else {
					line += ch;
					stream.push(ch);
				}
			}
		});
		return { stream, dispose: () => stream.destroy() };
	}

	async *openPreview(_nodeId: string, vmId: string, signal: AbortSignal): AsyncIterable<PreviewFrame> {
		const width = 320;
		const height = 200;
		let t = 0;
		while (!signal.aborted) {
			const vm = this.get(vmId);
			const data = new Uint8Array(width * height * 4);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const i = (y * width + x) * 4;
					const on = vm.state === 'running';
					data[i] = on ? (x + t) % 256 : 20;
					data[i + 1] = on ? (y * 2) % 256 : 20;
					data[i + 2] = on ? 160 : 20;
					data[i + 3] = 255;
				}
			}
			yield { width, height, format: 'rgba', data };
			t += 8;
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	dispose() {
		this.emitter.dispose();
	}
}
