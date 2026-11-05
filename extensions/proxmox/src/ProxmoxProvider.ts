import { Agent } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pve-client';
import { consoleStream } from './console';
import { proxmoxFetch } from './transport';
import { tokenTerminal } from './terminal';

import { ProviderError, validateValues, type ClusterConfig, type ClusterConnection, type ConsoleKind, type ConsoleStream, type DeleteOptions, type FieldSchema, type FieldValues, type HypervisorProvider, type PowerAction, type SecretBag, type VmInfo } from '@vmm/sdk';

/** Whether the VM has a graphical display: `vga` is `serialN` (terminal as display) or `none` otherwise absent. */
export function hasDisplay(config: object): boolean {
	const vga = String((config as Record<string, unknown>).vga ?? '').split(',')[0]!.trim();
	return !/^(serial[0-3]|none)$/.test(vga);
}

/**
 * Consoles to offer for a guest. The resources endpoint says whether it is a container (a terminal
 * only); a QEMU VM gets its display, and the serial terminal only when it has no display and a serial
 * socket device really exists (otherwise there is nothing to connect to). `config` undefined = unknown.
 */
export function proxmoxConsoles(container: boolean, config: object | undefined): ConsoleKind[] {
	if (container) return ['serial'];
	if (!config || hasDisplay(config)) return ['vnc'];
	return serialDevice(config) ? ['serial'] : [];
}

export function serialDevice(config: object): 'serial0' | 'serial1' | 'serial2' | 'serial3' | undefined {
	return (['serial0', 'serial1', 'serial2', 'serial3'] as const).find((key) => (config as Record<string, unknown>)[key] === 'socket');
}

const schema: FieldSchema[] = [
	{ key: 'name', label: 'Name', type: 'text', required: true },
	{ key: 'cores', label: 'CPU cores', type: 'number', default: 2, min: 1, max: 128, required: true },
	{ key: 'memory', label: 'Memory', type: 'number', default: 2048, min: 16, unit: 'MB', required: true },
	{ key: 'description', label: 'Description', type: 'textarea' },
	{ key: 'onboot', label: 'Start at boot', type: 'checkbox', default: false }
];

export function connectionOptions(cluster: ClusterConfig, secrets: SecretBag) {
	let url: URL;
	try { url = new URL(String(cluster.config.endpoint)); } catch { throw new ProviderError('Enter a valid Proxmox HTTPS URL.', 'invalid'); }
	if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ProviderError('Use an HTTPS origin such as https://pve.example.com:8006.', 'invalid');
	const tokenId = String(cluster.config.tokenId ?? '');
	if (!/^[^\s!=]+@[^\s!=]+![^\s=]+$/.test(tokenId) || !secrets.tokenSecret || /[\r\n]/.test(secrets.tokenSecret)) throw new ProviderError('Provide a token ID (user@realm!token) and secret.', 'invalid');
	return { baseUrl: url.origin, apiToken: `${tokenId}=${secrets.tokenSecret}`, verifyTls: cluster.config.verifyTls !== false };
}

export class ProxmoxProvider implements HypervisorProvider {
	readonly id = 'proxmox';
	readonly displayName = 'Proxmox VE';
	readonly icon = 'server-environment';
	readonly connectionSchema: FieldSchema[] = [
		{ key: 'endpoint', label: 'Proxmox URL', type: 'text', required: true, placeholder: 'https://pve.example.com:8006' },
		{ key: 'tokenId', label: 'API token ID', type: 'text', required: true, placeholder: 'user@pve!vscode' },
		{ key: 'tokenSecret', label: 'API token secret', type: 'password', required: true, secret: true },
		{ key: 'verifyTls', label: 'Verify TLS certificate', type: 'checkbox', default: true, description: 'Disable only for a trusted server with a self-signed certificate.' }
	];
	constructor(private readonly openUrl: (url: string) => PromiseLike<unknown>) {}
	async connect(cluster: ClusterConfig, secrets: SecretBag): Promise<ProxmoxConnection> {
		const options = connectionOptions(cluster, secrets);
		const agent = new Agent({ rejectUnauthorized: options.verifyTls, timeout: 30_000 });
		const connection = new ProxmoxConnection(new Client({ ...options, agent, fetch: proxmoxFetch(agent, options.verifyTls) }), options.baseUrl, this.openUrl, () => agent.destroy(), options.verifyTls);
		try { await connection.listNodes(); return connection; } catch (error) { connection.dispose(); throw error; }
	}
	async testConnection(cluster: ClusterConfig, secrets: SecretBag): Promise<void> { (await this.connect(cluster, secrets)).dispose(); }
}

export class ProxmoxConnection implements ClusterConnection {
	readonly capabilities = { create: true, edit: true, delete: true, power: ['start', 'shutdown', 'reboot', 'stop', 'reset'] as PowerAction[], consoles: ['vnc', 'serial'] as ConsoleKind[], preview: false, external: true, stats: true };
	private readonly abort = new AbortController();
	private readonly consoles = new Set<ConsoleStream>();
	private readonly containers = new Set<string>();
	private isContainer(node: string, id: string): boolean { return this.containers.has(`${node}/${id}`); }
	private container(node: string, id: string) { this.vm(node, id); return this.client.api.nodes.get(node).lxc.id(Number(id)); }
	constructor(private readonly client: Client, private readonly baseUrl: string, private readonly openUrl: (url: string) => PromiseLike<unknown>, private readonly cleanup: () => void = () => {}, private readonly verifyTls = true) {}
	private vm(node: string, id: string) {
		if (!/^\d+$/.test(id) || Number(id) < 100) throw new ProviderError('Invalid Proxmox VM ID.', 'invalid');
		return this.client.api.nodes.get(node).qemu.vmid(Number(id));
	}
	private async task(node: string, upid: string): Promise<void> {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			this.abort.signal.throwIfAborted();
			const status = await this.client.request('/nodes/{node}/tasks/{upid}/status', 'GET', { $path: { node, upid } }, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) });
			if (status.status === 'stopped') {
				if (status.exitstatus !== 'OK') throw new ProviderError(`Proxmox task failed: ${status.exitstatus ?? 'unknown error'}`);
				return;
			}
			await delay(1000, undefined, { signal: this.abort.signal });
		}
		throw new ProviderError('Proxmox task is still running. Check its status in the Proxmox web UI before retrying.', 'timeout');
	}
	async listNodes() {
		const nodes = await this.client.api.nodes.list();
		return nodes.map((n) => ({ id: n.node, name: n.node, status: n.status === 'online' ? 'online' as const : n.status === 'offline' ? 'offline' as const : 'unknown' as const, cpus: n.maxcpu, cpuUsage: n.cpu, memoryMB: n.maxmem === undefined ? undefined : n.maxmem / 1048576, memoryUsedMB: n.mem === undefined ? undefined : n.mem / 1048576 }));
	}
	async listVms(node: string): Promise<VmInfo[]> {
		const api = this.client.api.nodes.get(node);
		const [vms, containers] = await Promise.all([api.qemu.list(), api.lxc.list()]);
		for (const key of this.containers) if (key.startsWith(`${node}/`)) this.containers.delete(key);
		for (const guest of containers) this.containers.add(`${node}/${guest.vmid}`);
		return Promise.all([...vms.map((v) => ({ ...v, container: false })), ...containers.map((v) => ({ ...v, container: true }))]
			.filter((v) => !v.template).map(async (v): Promise<VmInfo> => {
				const config = v.container ? undefined : await api.qemu.vmid(v.vmid).config.get().then((c) => c as object, () => undefined);
				return ({ id: String(v.vmid), name: v.name || `Guest ${v.vmid}`, state: v.status === 'running' ? 'running' : v.status === 'stopped' ? 'stopped' : 'unknown', cpus: v.cpus, memoryMB: v.maxmem === undefined ? undefined : v.maxmem / 1048576, uptimeSeconds: v.uptime, consoles: proxmoxConsoles(v.container, config), ...(v.container ? { description: 'LXC container' } : {}) });
			}));
	}
	async getCreateSchema(node: string): Promise<FieldSchema[]> {
		const stores = await this.client.api.nodes.get(node).storage.list();
		const options = stores.filter((s) => s.active && s.enabled && s.content?.split(',').includes('images')).map((s) => ({ value: s.storage, label: s.storage }));
		return [...schema, { key: 'storage', label: 'Disk storage', type: 'select', required: true, options }, { key: 'diskGB', label: 'Disk size', type: 'number', default: 32, min: 1, unit: 'GB', required: true }, { key: 'bridge', label: 'Network bridge', type: 'text', default: 'vmbr0', required: true }, { key: 'iso', label: 'ISO volume (optional)', type: 'text', placeholder: 'local:iso/installer.iso' }];
	}
	private settings(values: FieldValues) {
		const invalid = validateValues(schema, values);
		if (invalid) throw new ProviderError(invalid.message, 'invalid');
		if (!Number.isInteger(Number(values.cores)) || !Number.isInteger(Number(values.memory))) throw new ProviderError('CPU cores and memory must be integers.', 'invalid');
		return { name: String(values.name), cores: Number(values.cores), memory: Number(values.memory), description: String(values.description ?? ''), onboot: values.onboot === true ? 1 as const : 0 as const };
	}
	async createVm(node: string, values: FieldValues): Promise<VmInfo> {
		const fields = await this.getCreateSchema(node);
		const invalid = validateValues(fields, values);
		if (invalid) throw new ProviderError(invalid.message, 'invalid');
		if (!/^[\w.-]+$/.test(String(values.bridge))) throw new ProviderError('Invalid network bridge.', 'invalid');
		const vmid = Number(await this.client.api.cluster.nextid());
		const body = { ...this.settings(values), memory: String(values.memory), vmid, scsihw: 'virtio-scsi-single' as const, scsi0: `${values.storage}:${Number(values.diskGB)}`, net0: `virtio,bridge=${values.bridge}`, ...(values.iso ? { ide2: `${values.iso},media=cdrom`, boot: 'order=ide2;scsi0;net0' } : { boot: 'order=scsi0;net0' }) };
		const upid = await this.client.request('/nodes/{node}/qemu', 'POST', { $path: { node }, $body: body });
		await this.task(node, upid);
		const vm = (await this.listVms(node)).find((v) => v.id === String(vmid));
		if (!vm) throw new ProviderError(`VM ${vmid} was created but could not be read. Refresh the cluster.`);
		return vm;
	}
	async getVmConfig(node: string, id: string) {
		const container = this.isContainer(node, id);
		const config = container ? await this.container(node, id).config.get() : await this.vm(node, id).config.get();
		return { schema, values: { name: ('hostname' in config ? config.hostname : 'name' in config ? config.name : '') ?? '', cores: config.cores ?? 1, memory: config.memory ?? 512, description: config.description ?? '', onboot: Boolean(config.onboot) } };
	}
	async updateVm(node: string, id: string, values: FieldValues): Promise<void> {
		const settings = this.settings(values);
		if (this.isContainer(node, id)) {
			const { name, ...rest } = settings;
			await this.container(node, id).config.update({ $body: { ...rest, hostname: name } });
		} else await this.vm(node, id).config.update({ $body: settings });
	}
	async deleteVm(node: string, id: string, options: DeleteOptions): Promise<void> {
		if (!options.deleteDisks) throw new ProviderError('Proxmox VM deletion also removes its owned disks. Select delete disks to continue.', 'unsupported');
		this.vm(node, id);
		const upid = this.isContainer(node, id) ? await this.container(node, id).destroy() : await this.client.request('/nodes/{node}/qemu/{vmid}', 'DELETE', { $path: { node, vmid: Number(id) } });
		await this.task(node, upid);
	}
	async power(node: string, id: string, action: PowerAction): Promise<void> {
		if (this.isContainer(node, id)) {
			if (action === 'reset') throw new ProviderError('LXC containers support reboot rather than hardware reset.', 'unsupported');
			const status = this.container(node, id).status;
			await this.task(node, await status[action]());
			return;
		}
		const status = this.vm(node, id).status;
		const upid = await ({ start: () => status.start(), shutdown: () => status.shutdown(), reboot: () => status.reboot(), stop: () => status.stop(), reset: () => status.reset() })[action]();
		await this.task(node, upid);
	}
	private resourceSample?: { expires: number; promise: ReturnType<Client['api']['cluster']['resources']['index']> };
	private resources() {
		if (!this.resourceSample || this.resourceSample.expires <= Date.now()) {
			const promise = this.client.api.cluster.resources.index({ $query: { type: 'vm' } });
			this.resourceSample = { expires: Date.now() + 2000, promise };
			void promise.catch(() => { if (this.resourceSample?.promise === promise) this.resourceSample = undefined; });
		}
		return this.resourceSample.promise;
	}
	async getVmStats(node: string, id: string) {
		const [current, resources] = await Promise.allSettled([
			this.isContainer(node, id) ? this.container(node, id).status.current() : this.vm(node, id).status.current(),
			this.resources()
		]);
		const resource = resources.status === 'fulfilled' ? resources.value.find((r) => r.node === node && String(r.vmid) === id) : undefined;
		if (current.status === 'rejected' && !resource) throw current.reason;
		const s = { ...resource, ...(current.status === 'fulfilled' ? current.value : {}) };
		return {
			timestamp: Date.now(), uptimeSeconds: s.uptime, cpuUsage: s.cpu,
			memoryUsedMB: s.mem === undefined ? undefined : s.mem / 1048576,
			memoryMB: s.maxmem === undefined ? undefined : s.maxmem / 1048576,
			diskIo: s.diskread !== undefined && s.diskwrite !== undefined ? { readBytes: s.diskread, writeBytes: s.diskwrite } : undefined,
			diskUsage: s.disk !== undefined || s.maxdisk !== undefined ? { usedBytes: s.disk, capacityBytes: s.maxdisk } : undefined,
			network: s.netin !== undefined && s.netout !== undefined ? { rxBytes: s.netin, txBytes: s.netout } : undefined
		};
	}
	async openConsole(node: string, id: string, kind: ConsoleKind): Promise<ConsoleStream> {
		this.vm(node, id);
		if (kind !== 'vnc' && kind !== 'serial') throw new ProviderError('Unsupported Proxmox console type.', 'unsupported');
		const container = this.isContainer(node, id);
		if (container && kind === 'vnc') throw new ProviderError('Use Terminal for LXC containers.', 'unsupported');
		let serial: ReturnType<typeof serialDevice>;
		if (kind === 'serial' && !container) {
			const config = await this.vm(node, id).config.get();
			serial = serialDevice(config);
			if (!serial) throw new ProviderError('This VM needs a serial socket device. Add a serial port in Proxmox Hardware and configure the guest OS to use its serial console.', 'unsupported');
		}
		try {
			const client = this.client;
			this.abort.signal.throwIfAborted();
			const display = kind === 'vnc' ? client.helpers.display(Number(id)) : undefined;
			const terminal = kind === 'serial' ? tokenTerminal(client, node, Number(id), this.verifyTls, container ? 'lxc' : 'qemu', serial) : undefined;
			const session = terminal ?? await display!.open({ rejectUnauthorized: this.verifyTls });
			const console = consoleStream(session, kind === 'serial');
			this.consoles.add(console);
			console.stream.once('close', () => this.consoles.delete(console));
			if (display?.ticket) console.credentials = { password: display.ticket.ticket };
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => { console.dispose(); reject(new ProviderError('Proxmox console connection timed out.', 'timeout')); }, 30_000);
				const finish = (error?: Error) => { clearTimeout(timer); session.removeListener('ready', ready); session.removeListener('error', failed); session.removeListener('close', closed); error ? reject(error) : resolve(); };
				const ready = () => finish();
				const failed = (error: Error) => { finish(error); console.dispose(); };
				const closed = () => finish(new ProviderError('Proxmox closed the console connection. Check VM.Console permission and guest console configuration.'));
				session.once('ready', ready); session.once('error', failed); session.once('close', closed);
				if (terminal) void terminal.start().catch(failed);
			});
			return console;
		} catch (error) {
			if (/HTTP (401|403)|Unexpected server response: (401|403)/.test(String(error))) throw new ProviderError('Proxmox rejected console access for the configured API token. Check its effective VM.Console permission and whether this Proxmox version supports tokens on this console endpoint.', 'permission');
			throw error;
		}
	}
	async openExternal(node: string, id: string): Promise<void> {
		this.vm(node, id);
		await this.openUrl(`${this.baseUrl}/#v1:0:=${this.isContainer(node, id) ? 'lxc' : 'qemu'}%2F${encodeURIComponent(id)}:4`);
	}
	dispose(): void { this.abort.abort(); for (const console of this.consoles) console.dispose(); this.consoles.clear(); this.client.events.stopListening(); this.cleanup(); }
}
