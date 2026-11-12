import { Agent } from 'node:https';
import {
	ProviderError, validateValues,
	type Capabilities, type ClusterConfig, type ClusterConnection, type ConsoleKind, type ConsoleStream, type CreateProgress, type DeleteOptions,
	type FieldSchema, type FieldValues, type HypervisorProvider, type NodeInfo, type PowerAction, type ProviderContext, type SecretBag,
	type Snapshot, type VmConfig, type VmDetails, type VmInfo, type VmStats
} from '@vmm/sdk';
import { NutanixClient, nutanixFetch, taskOf, type Credentials, type Reference } from './client';
import { openVncConsole, vncProxyUrl } from './console';
import {
	diskDevices, groupValue, hostDevices, isPrismCentral, nicDevices, nodeInfo, vmCluster, vmInfo, vmRecoveryPoints,
	type ClusterEntity, type HostEntity, type RecoveryPointEntity, type VmDisk, type VmEntity
} from './inventory';

/** The v3 API version sent with intent requests. */
const API_VERSION = '3.1.0';

export type ConnectionOptions = { baseUrl: string; verifyTls: boolean } & (
	/** `savedPassword`: the password saved in the OS keychain; undefined = ask at sign-in. */
	| { method: 'password'; username: string; savedPassword?: string }
	| { method: 'apiKey'; apiKey: string }
);

export function connectionOptions(cluster: ClusterConfig, secrets: SecretBag): ConnectionOptions {
	let url: URL;
	try { url = new URL(String(cluster.config.endpoint ?? '')); } catch { throw new ProviderError('Enter a valid Prism Central HTTPS URL.', 'invalid'); }
	if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
		throw new ProviderError('Use an HTTPS origin such as https://prism.example.com:9440.', 'invalid');
	}
	const common = { baseUrl: url.origin, verifyTls: cluster.config.verifyTls !== false };
	const method = String(cluster.config.authMethod ?? 'password');
	if (method === 'apiKey') {
		const apiKey = secrets.apiKey?.trim();
		if (!apiKey || /[\s]/.test(apiKey)) throw new ProviderError('Provide the Prism Central API key.', 'invalid');
		return { ...common, method, apiKey };
	}
	if (method !== 'password') throw new ProviderError('Unknown sign-in method.', 'invalid');
	const username = String(cluster.config.username ?? '').trim();
	// Basic auth cannot carry a colon in the user name.
	if (!username || /[:\s]/.test(username)) throw new ProviderError('Provide a Prism user name, for example admin or alice@example.com.', 'invalid');
	const remember = cluster.config.rememberPassword === true;
	if (remember && secrets.password && /[\r\n]/.test(secrets.password)) throw new ProviderError('Invalid password.', 'invalid');
	return { ...common, method, username, savedPassword: remember ? secrets.password || undefined : undefined };
}

/** Everything the provider needs from VS Code. */
export interface NutanixHost {
	prompt(options: { title: string; prompt: string; password?: boolean; placeholder?: string; value?: string }): PromiseLike<string | undefined>;
	openUrl(url: string): PromiseLike<unknown>;
}

const nameRule = (name: string) => {
	if (!name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new ProviderError('A name has 1 to 80 characters and no line breaks.', 'invalid');
};

const editSchema: FieldSchema[] = [
	{ key: 'name', label: 'Name', type: 'text', required: true },
	{ key: 'sockets', label: 'vCPUs', type: 'number', default: 2, min: 1, max: 240, required: true, description: 'Number of virtual CPU sockets.' },
	{ key: 'coresPerSocket', label: 'Cores per vCPU', type: 'number', default: 1, min: 1, max: 64, required: true, advanced: true },
	{ key: 'memory', label: 'Memory', type: 'number', default: 4096, min: 256, unit: 'MB', required: true },
	{ key: 'description', label: 'Description', type: 'textarea' }
];

export class NutanixProvider implements HypervisorProvider {
	readonly id = 'nutanix';
	readonly displayName = 'Nutanix';
	readonly icon = 'server-environment';
	readonly connectionSchema: FieldSchema[] = [
		{ key: 'endpoint', label: 'Prism Central URL', type: 'text', required: true, placeholder: 'https://prism.example.com:9440', description: 'A Prism Element address works too, for that one cluster.' },
		{ key: 'authMethod', label: 'Sign in with', type: 'select', default: 'password', required: true, options: [{ value: 'password', label: 'User name and password' }, { value: 'apiKey', label: 'API key (Prism Central 2024.3 and later)' }] },
		{ key: 'apiKey', showWhen: { key: 'authMethod', default: 'password', equals: 'apiKey' }, label: 'API key', type: 'password', secret: true, description: 'Created under Admin Center → IAM → Service accounts. Kept in the OS keychain.' },
		{ key: 'username', showWhen: { key: 'authMethod', default: 'password', equals: 'password' }, label: 'User name', type: 'text', required: true, placeholder: 'admin or alice@example.com' },
		{ key: 'rememberPassword', showWhen: { key: 'authMethod', default: 'password', equals: 'password' }, label: 'Remember password', type: 'checkbox', default: false, description: 'Off: you are asked for the password at the first sign-in after VS Code starts, and it is kept in memory only. On: it is kept in the OS keychain.' },
		{ key: 'password', showWhen: { key: 'rememberPassword', equals: true }, label: 'Password', type: 'password', secret: true },
		{ key: 'verifyTls', label: 'Verify TLS certificate', type: 'checkbox', default: true, description: 'Disable only for a trusted server with a self-signed certificate.' }
	];
	/** Passwords typed at sign-in, by cluster id. In memory only: gone when VS Code closes or the user signs out. */
	private readonly passwords = new Map<string, string>();
	/** `transport` builds the HTTPS fetch; tests replace it with a fake Prism. */
	constructor(private readonly host: NutanixHost, private readonly transport: (agent: Agent, verifyTls: boolean) => typeof fetch = nutanixFetch) {}
	defaultClusterName(): string { return 'Nutanix'; }
	async connect(cluster: ClusterConfig, secrets: SecretBag, context?: ProviderContext): Promise<NutanixConnection> {
		const options = connectionOptions(cluster, secrets);
		if (options.method === 'apiKey') {
			const connection = this.open(options, { apiKey: options.apiKey });
			try { await connection.listNodes(); } catch (error) { connection.dispose(); throw error; }
			return connection;
		}
		let password = options.savedPassword ?? this.passwords.get(cluster.id);
		if (!password) {
			// An automatic connect (opening the view) must never prompt: report that sign-in is needed.
			if (context?.interactive === false) throw new ProviderError('Sign in required.', 'authRequired');
			password = await this.host.prompt({ title: `Nutanix sign-in for ${options.username}`, prompt: `Password for ${new URL(options.baseUrl).host}`, password: true });
			if (!password) throw new ProviderError('Sign-in cancelled.', 'permission');
		}
		const remembered = options.savedPassword !== undefined;
		const connection = this.open(options, { username: options.username, password }, remembered ? undefined : async () => { this.passwords.delete(cluster.id); });
		try {
			await connection.listNodes();
		} catch (error) {
			connection.dispose();
			// Never retry a rejected password: repeated failures can lock the account.
			if (error instanceof ProviderError && error.code === 'permission') this.passwords.delete(cluster.id);
			if (error instanceof ProviderError && error.code === 'permission' && remembered) throw new ProviderError('Prism rejected the user name or the saved password. Edit the cluster to update them.', 'permission');
			throw error;
		}
		if (!remembered) this.passwords.set(cluster.id, password);
		return connection;
	}
	private open(options: ConnectionOptions, credentials: Credentials, endSession?: () => Promise<void>): NutanixConnection {
		const agent = new Agent({ rejectUnauthorized: options.verifyTls, keepAlive: true, timeout: 60_000 });
		const abort = new AbortController();
		const client = new NutanixClient(options.baseUrl, credentials, this.transport(agent, options.verifyTls), abort.signal);
		return new NutanixConnection(client, options.verifyTls, (url) => this.host.openUrl(url), () => { abort.abort(); agent.destroy(); }, endSession);
	}
	async testConnection(cluster: ClusterConfig, secrets: SecretBag, context?: ProviderContext): Promise<void> { (await this.connect(cluster, secrets, context)).dispose(); }
	/** Forgets every password typed at sign-in. */
	forgetPasswords(): void { this.passwords.clear(); }
}

/** A subnet a new VM can be attached to. */
interface SubnetEntity {
	metadata: { uuid: string };
	spec?: { name?: string; cluster_reference?: Reference; resources?: { subnet_type?: string; vlan_id?: number } };
	status?: { name?: string; cluster_reference?: Reference; resources?: { subnet_type?: string; vlan_id?: number; cluster_reference_list?: Reference[] } };
}

interface ImageEntity {
	metadata: { uuid: string };
	spec?: { name?: string };
	status?: { name?: string; state?: string; resources?: { image_type?: 'DISK_IMAGE' | 'ISO_IMAGE' | string; size_bytes?: number; current_cluster_reference_list?: Reference[] } };
}

export function subnetOptions(subnets: SubnetEntity[], clusterId: string) {
	return subnets
		.filter((s) => {
			const owner = s.status?.cluster_reference?.uuid ?? s.spec?.cluster_reference?.uuid;
			const shared = s.status?.resources?.cluster_reference_list;
			return owner ? owner === clusterId : !shared?.length || shared.some((c) => c.uuid === clusterId);
		})
		.map((s) => {
			const resources = s.status?.resources ?? s.spec?.resources;
			const name = s.status?.name ?? s.spec?.name ?? s.metadata.uuid;
			return { value: s.metadata.uuid, label: name, description: resources?.subnet_type === 'OVERLAY' ? 'VPC subnet' : resources?.vlan_id !== undefined ? `VLAN ${resources.vlan_id}` : undefined };
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}

export function imageOptions(images: ImageEntity[], clusterId: string, type: 'DISK_IMAGE' | 'ISO_IMAGE') {
	return images
		.filter((i) => i.status?.resources?.image_type === type && (i.status.state ?? 'COMPLETE') === 'COMPLETE')
		.filter((i) => { const on = i.status?.resources?.current_cluster_reference_list; return !on?.length || on.some((c) => c.uuid === clusterId); })
		.map((i) => ({ value: i.metadata.uuid, label: i.status?.name ?? i.spec?.name ?? i.metadata.uuid }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** The VM spec for `POST /vms`, from the create form. */
export function createSpec(clusterId: string, values: FieldValues, imageSizeBytes?: number) {
	const diskMib = Number(values.diskGB) * 1024;
	const disks: VmDisk[] = [];
	if (values.image) {
		// A disk cloned from an image is at least the image's size; a larger size grows it.
		const grow = imageSizeBytes === undefined || diskMib * 1024 * 1024 > imageSizeBytes;
		disks.push({ device_properties: { device_type: 'DISK', disk_address: { adapter_type: 'SCSI', device_index: 0 } }, data_source_reference: { kind: 'image', uuid: String(values.image) }, ...(grow && diskMib > 0 ? { disk_size_mib: diskMib } : {}) });
	} else if (diskMib > 0) {
		disks.push({ device_properties: { device_type: 'DISK', disk_address: { adapter_type: 'SCSI', device_index: 0 } }, disk_size_mib: diskMib });
	}
	disks.push({ device_properties: { device_type: 'CDROM', disk_address: { adapter_type: 'IDE', device_index: 0 } }, ...(values.iso ? { data_source_reference: { kind: 'image', uuid: String(values.iso) } } : {}) });
	const userData = String(values.cloudInit ?? '').trim();
	return {
		api_version: API_VERSION,
		metadata: { kind: 'vm' },
		spec: {
			name: String(values.name),
			...(values.description ? { description: String(values.description) } : {}),
			cluster_reference: { kind: 'cluster', uuid: clusterId },
			resources: {
				num_sockets: Number(values.sockets),
				num_vcpus_per_socket: Number(values.coresPerSocket ?? 1),
				memory_size_mib: Number(values.memory),
				power_state: values.start === true ? 'ON' : 'OFF',
				disk_list: disks,
				nic_list: values.subnet ? [{ subnet_reference: { kind: 'subnet', uuid: String(values.subnet) }, is_connected: true }] : [],
				boot_config: { boot_device_order_list: values.iso && !values.image ? ['CDROM', 'DISK', 'NETWORK'] : ['DISK', 'CDROM', 'NETWORK'] },
				...(userData ? { guest_customization: { cloud_init: { user_data: Buffer.from(userData, 'utf8').toString('base64') } } } : {})
			}
		}
	};
}

/** A VM as it can be sent back with `PUT /vms/{uuid}`: its spec and metadata, never the status. */
function intentInput(vm: VmEntity) {
	if (!vm.spec) throw new ProviderError('Prism returned the VM without its spec.');
	return { api_version: API_VERSION, metadata: vm.metadata, spec: structuredClone(vm.spec) };
}

const uuidRule = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NutanixConnection implements ClusterConnection {
	readonly capabilities: Capabilities = {
		details: true, create: true, edit: true, delete: true, stats: true,
		power: ['start', 'shutdown', 'reboot', 'stop', 'reset'] as PowerAction[],
		consoles: ['vnc'] as ConsoleKind[], preview: false, external: true,
		snapshots: true, snapshotRevertNeedsStopped: true, clone: true
	};
	private readonly consoles = new Set<ConsoleStream>();
	private vmSample?: { expires: number; promise: Promise<VmEntity[]> };
	private hostSample?: { expires: number; promise: Promise<HostEntity[]> };
	constructor(private readonly client: NutanixClient, private readonly verifyTls: boolean, private readonly openUrl: (url: string) => PromiseLike<unknown>, private readonly cleanup: () => void = () => {}, private readonly endSession?: () => Promise<void>) {
		if (endSession) this.capabilities = { ...this.capabilities, signOut: true };
	}
	private path(id: string): string {
		if (!uuidRule.test(id)) throw new ProviderError('Invalid Nutanix VM id.', 'invalid');
		return `/vms/${id}`;
	}
	/** Every VM, shared for a few seconds by the per-node listings of one refresh. */
	private allVms(maxAgeMs = 3000): Promise<VmEntity[]> {
		if (!this.vmSample || this.vmSample.expires <= Date.now()) {
			const promise = this.client.listAll<VmEntity>('/vms/list', 'vm', undefined, 250);
			this.vmSample = { expires: Date.now() + maxAgeMs, promise };
			void promise.catch(() => { if (this.vmSample?.promise === promise) this.vmSample = undefined; });
		}
		return this.vmSample.promise;
	}
	private invalidate(): void { this.vmSample = undefined; }
	private hosts(): Promise<HostEntity[]> {
		if (!this.hostSample || this.hostSample.expires <= Date.now()) {
			const promise = this.client.listAll<HostEntity>('/hosts/list', 'host').catch(() => []);
			this.hostSample = { expires: Date.now() + 60_000, promise };
		}
		return this.hostSample.promise;
	}
	private getVm(id: string): Promise<VmEntity> { return this.client.request<VmEntity>('GET', this.path(id)); }
	async listNodes(): Promise<NodeInfo[]> {
		const [clusters, hosts] = await Promise.all([this.client.listAll<ClusterEntity>('/clusters/list', 'cluster'), this.hosts()]);
		return clusters.filter((c) => !isPrismCentral(c)).map((c) => nodeInfo(c, hosts));
	}
	async listVms(node: string): Promise<VmInfo[]> {
		return (await this.allVms()).filter((vm) => vmCluster(vm) === node).map(vmInfo);
	}
	async getVmDetails(_node: string, id: string): Promise<VmDetails> {
		const resources = (await this.getVm(id)).status?.resources;
		return { disks: diskDevices(resources), nics: nicDevices(resources), devices: hostDevices(resources), forwards: [] };
	}
	async getCreateSchema(node: string): Promise<FieldSchema[]> {
		const [subnets, images] = await Promise.all([
			this.client.listAll<SubnetEntity>('/subnets/list', 'subnet').catch(() => []),
			this.client.listAll<ImageEntity>('/images/list', 'image').catch(() => [])
		]);
		const networks = subnetOptions(subnets, node);
		return [
			...editSchema,
			{ key: 'subnet', label: 'Network', type: 'select', required: networks.length > 0, options: networks, ...(networks[0] ? { default: networks[0].value } : {}), description: networks.length ? undefined : 'No subnet is available on this cluster: the VM is created without a network adapter.' },
			{ key: 'image', label: 'Disk image', type: 'select', options: [{ value: '', label: 'None (empty disk)' }, ...imageOptions(images, node, 'DISK_IMAGE')], default: '', description: 'Clone the system disk from an image, for example a cloud image.' },
			{ key: 'diskGB', label: 'Disk size', type: 'number', default: 32, min: 1, unit: 'GB', required: true },
			{ key: 'iso', label: 'CD-ROM', type: 'select', options: [{ value: '', label: 'Empty drive' }, ...imageOptions(images, node, 'ISO_IMAGE')], default: '' },
			{ key: 'cloudInit', label: 'cloud-init user data', type: 'textarea', advanced: true, placeholder: '#cloud-config', description: 'Applied at first boot by an image with cloud-init.' },
			{ key: 'start', label: 'Start after creation', type: 'checkbox', default: false }
		];
	}
	async createVm(node: string, values: FieldValues, progress?: (update: CreateProgress) => void): Promise<VmInfo> {
		const fields = await this.getCreateSchema(node);
		const invalid = validateValues(fields, values);
		if (invalid) throw new ProviderError(invalid.message, 'invalid');
		nameRule(String(values.name));
		for (const key of ['image', 'iso', 'subnet'] as const) if (values[key] && !uuidRule.test(String(values[key]))) throw new ProviderError(`Invalid ${key}.`, 'invalid');
		let imageSize: number | undefined;
		if (values.image) imageSize = (await this.client.request<ImageEntity>('GET', `/images/${values.image}`)).status?.resources?.size_bytes;
		progress?.({ message: 'Creating the VM in Prism' });
		const reply = await this.client.request<VmEntity>('POST', '/vms', createSpec(node, values, imageSize));
		await this.client.waitTask(taskOf(reply), 600_000);
		this.invalidate();
		return vmInfo(await this.getVm(reply.metadata.uuid));
	}
	async getVmConfig(_node: string, id: string): Promise<VmConfig> {
		const vm = await this.getVm(id);
		const resources = vm.spec?.resources ?? vm.status?.resources;
		return { schema: editSchema, values: { name: vm.spec?.name ?? vm.status?.name ?? '', sockets: resources?.num_sockets ?? 1, coresPerSocket: resources?.num_vcpus_per_socket ?? 1, memory: resources?.memory_size_mib ?? 1024, description: vm.spec?.description ?? '' } };
	}
	/** Reads the VM, changes its spec and sends it back (the v3 API replaces the whole spec), then waits for Prism to apply it. */
	private async change(id: string, edit: (spec: NonNullable<VmEntity['spec']>) => void, timeoutMs = 120_000): Promise<void> {
		const input = intentInput(await this.getVm(id));
		edit(input.spec);
		const reply = await this.client.request<unknown>('PUT', this.path(id), input);
		this.invalidate();
		await this.client.waitTask(taskOf(reply), timeoutMs);
		this.invalidate();
	}
	async updateVm(_node: string, id: string, values: FieldValues): Promise<void> {
		const invalid = validateValues(editSchema, values);
		if (invalid) throw new ProviderError(invalid.message, 'invalid');
		nameRule(String(values.name));
		for (const key of ['sockets', 'coresPerSocket', 'memory'] as const) if (!Number.isInteger(Number(values[key]))) throw new ProviderError('vCPUs, cores and memory must be whole numbers.', 'invalid');
		await this.change(id, (spec) => {
			spec.name = String(values.name);
			if (values.description) spec.description = String(values.description); else delete spec.description;
			spec.resources.num_sockets = Number(values.sockets);
			spec.resources.num_vcpus_per_socket = Number(values.coresPerSocket ?? 1);
			spec.resources.memory_size_mib = Number(values.memory);
		});
	}
	async deleteVm(_node: string, id: string, options: DeleteOptions): Promise<void> {
		if (!options.deleteDisks) throw new ProviderError('Deleting a Nutanix VM also deletes its disks. Select delete disks to continue.', 'unsupported');
		const reply = await this.client.request<unknown>('DELETE', this.path(id));
		await this.client.waitTask(taskOf(reply), 600_000);
		this.invalidate();
	}
	async power(_node: string, id: string, action: PowerAction): Promise<void> {
		if (action === 'start' || action === 'stop') {
			await this.change(id, (spec) => {
				spec.resources.power_state = action === 'start' ? 'ON' : 'OFF';
				if (action === 'stop') spec.resources.power_state_mechanism = { mechanism: 'HARD' };
				else delete spec.resources.power_state_mechanism;
			});
			return;
		}
		// Shutdown and reboot go to the guest through ACPI; reset is a hard reset.
		const endpoint = { shutdown: 'acpi_shutdown', reboot: 'acpi_reboot', reset: 'reset' }[action];
		let reply: unknown;
		try {
			reply = await this.client.request<unknown>('POST', `${this.path(id)}/${endpoint}`, {});
		} catch (error) {
			if (error instanceof ProviderError && error.code === 'notFound' && action === 'shutdown') {
				// Older Prism Central versions without the power endpoints: an ACPI power-off through the spec.
				await this.change(id, (spec) => { spec.resources.power_state = 'OFF'; spec.resources.power_state_mechanism = { mechanism: 'ACPI' }; });
				return;
			}
			throw error;
		}
		this.invalidate();
		await this.client.waitTask(taskOf(reply), 120_000);
		this.invalidate();
	}
	async getVmStats(_node: string, id: string): Promise<VmStats> {
		const cached = (this.vmSample ? await this.vmSample.promise.catch(() => []) : []).find((vm) => vm.metadata.uuid === id);
		const [vm, groups] = await Promise.allSettled([
			cached ? Promise.resolve(cached) : this.getVm(id),
			this.client.request<unknown>('POST', '/groups', {
				entity_type: 'mh_vm', entity_ids: [id],
				group_member_attributes: ['hypervisor_cpu_usage_ppm', 'memory_usage_ppm', 'hypervisor_memory_usage_ppm'].map((attribute) => ({ attribute }))
			})
		]);
		if (vm.status === 'rejected' && groups.status === 'rejected') throw vm.reason;
		const memoryMB = vm.status === 'fulfilled' ? (vm.value.status?.resources ?? vm.value.spec?.resources)?.memory_size_mib : undefined;
		const reply = groups.status === 'fulfilled' ? groups.value : undefined;
		const cpu = groupValue(reply, 'hypervisor_cpu_usage_ppm');
		const guest = groupValue(reply, 'memory_usage_ppm');
		const host = groupValue(reply, 'hypervisor_memory_usage_ppm');
		const memory = guest ?? host;
		return {
			timestamp: Date.now(),
			...(cpu !== undefined ? { cpuUsage: Math.min(1, cpu / 1_000_000) } : {}),
			...(memoryMB !== undefined ? { memoryMB } : {}),
			...(memory !== undefined && memoryMB !== undefined ? { memoryUsedMB: (memory / 1_000_000) * memoryMB, memorySource: guest !== undefined ? 'guest' as const : 'host' as const } : {})
		};
	}
	async listSnapshots(_node: string, id: string): Promise<Snapshot[]> {
		this.path(id);
		return vmRecoveryPoints(await this.client.listAll<RecoveryPointEntity>('/vm_recovery_points/list', 'vm_recovery_point'), id);
	}
	async createSnapshot(node: string, id: string, name: string): Promise<Snapshot> {
		nameRule(name);
		const reply = await this.client.request<unknown>('POST', `${this.path(id)}/snapshot`, { name, recovery_point_type: 'CRASH_CONSISTENT' });
		const task = await this.client.waitTask(taskOf(reply), 600_000);
		const created = task.entity_reference_list?.find((r) => r.kind === 'vm_recovery_point')?.uuid;
		const list = await this.listSnapshots(node, id);
		return list.find((s) => s.id === created) ?? [...list].reverse().find((s) => s.name === name) ?? { id: created ?? name, name, includesMemory: false };
	}
	async revertSnapshot(_node: string, id: string, snapshotId: string): Promise<void> {
		if (!uuidRule.test(snapshotId)) throw new ProviderError('Invalid recovery point id.', 'invalid');
		const reply = await this.client.request<unknown>('POST', `${this.path(id)}/revert`, { vm_recovery_point_uuid: snapshotId });
		await this.client.waitTask(taskOf(reply), 600_000);
		this.invalidate();
	}
	async deleteSnapshot(_node: string, id: string, snapshotId: string): Promise<void> {
		this.path(id);
		if (!uuidRule.test(snapshotId)) throw new ProviderError('Invalid recovery point id.', 'invalid');
		const reply = await this.client.request<unknown>('DELETE', `/vm_recovery_points/${snapshotId}`);
		await this.client.waitTask(taskOf(reply), 600_000);
	}
	async cloneVm(_node: string, id: string, name: string): Promise<VmInfo> {
		nameRule(name);
		const reply = await this.client.request<unknown>('POST', `${this.path(id)}/clone`, { override_spec: { name } });
		const task = await this.client.waitTask(taskOf(reply), 3_600_000);
		this.invalidate();
		const created = task.entity_reference_list?.find((r) => r.kind === 'vm' && r.uuid !== id)?.uuid;
		if (created) return vmInfo(await this.getVm(created));
		const vm = (await this.allVms()).find((v) => (v.status?.name ?? v.spec?.name) === name && v.metadata.uuid !== id);
		if (!vm) throw new ProviderError(`The clone "${name}" was created but could not be read. Refresh the cluster.`);
		return vmInfo(vm);
	}
	async openConsole(_node: string, id: string, kind: ConsoleKind): Promise<ConsoleStream> {
		if (kind !== 'vnc') throw new ProviderError('Nutanix VMs offer their display console only.', 'unsupported');
		const vm = await this.getVm(id);
		if (vm.status?.resources?.vga_console_enabled === false) throw new ProviderError('The VGA console is turned off for this VM.', 'unsupported');
		const console = await openVncConsole(vncProxyUrl(this.client.baseUrl, id, vmCluster(vm)), this.client.authHeaders(), this.verifyTls);
		this.consoles.add(console);
		console.stream.once('close', () => this.consoles.delete(console));
		return console;
	}
	/** Opens Prism in the browser (which has its own sign-in). */
	async openExternal(_node: string, id: string): Promise<void> {
		this.path(id);
		await this.openUrl(`${this.client.baseUrl}/`);
	}
	/** Forgets the password typed at sign-in. The core then drops the connection. */
	async signOut(): Promise<void> { await this.endSession?.(); }
	dispose(): void {
		for (const console of this.consoles) console.dispose();
		this.consoles.clear();
		this.cleanup();
	}
}
