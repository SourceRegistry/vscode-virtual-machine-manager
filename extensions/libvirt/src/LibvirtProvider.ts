import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
	ProviderError, type Capabilities, type ClusterConfig, type ClusterConnection, type ConsoleKind, type ConsoleStream, type DeleteOptions,
	type DiskStats, type FieldSchema, type FieldValues, type HypervisorProvider, type Logger, type NodeInfo, type PowerAction, type ProviderContext,
	type SecretBag, type Snapshot, type VmConfig, type VmDetails, type VmInfo, type VmStats
} from '@vmm/sdk';
import { openEndpoint, openPty } from './consoles';
import {
	blockStats, netStats, parseDomain, parseDomifaddr, parseDomstats, parseNodeinfo, parseSnapshot, parseVersion, parseVncDisplay, stateOf, toDiskDevices, toNicDevices, UUID,
	type DomainInfo
} from './parse';
import { sampleProcesses, type QemuProcess } from './process';
import { buildUri, isLocalUri, remoteLabel, sshTarget } from './uri';
import { execRunner, findVirsh, Virsh, type Runner } from './virsh';

const NODE_ID = 'host';
const SNAPSHOT_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const DISK_TARGET = /^[a-z0-9]{1,16}$/;

function assertId(vmId: string): string {
	if (!UUID.test(vmId)) throw new ProviderError('Invalid domain id.', 'invalid');
	return vmId;
}

export class LibvirtProvider implements HypervisorProvider {
	readonly id = 'libvirt';
	readonly displayName = 'libvirt';
	readonly icon = 'server-environment';
	readonly connectionSchema: FieldSchema[] = [
		{
			key: 'connection', label: 'Connection', type: 'select', default: 'session', required: true,
			options: [
				{ value: 'session', label: 'This computer, my user (qemu:///session)', description: 'Domains of your own user; no privileges needed. The only choice on macOS.' },
				{ value: 'system', label: 'This computer, system-wide (qemu:///system)', description: 'Linux: needs access to libvirt (the "libvirt" group).' },
				{ value: 'ssh', label: 'Another computer over SSH (qemu+ssh://)', description: 'Uses ssh with a key or the agent; no password prompts.' },
				{ value: 'custom', label: 'Custom URI', description: 'Any libvirt URI virsh understands.' }
			]
		},
		{ key: 'sshHost', label: 'SSH host', type: 'text', required: true, placeholder: 'lab.example.com or an alias of ~/.ssh/config', showWhen: { key: 'connection', equals: 'ssh', default: 'session' } },
		{ key: 'sshUser', label: 'SSH user', type: 'text', placeholder: 'leave empty to use ssh config', showWhen: { key: 'connection', equals: 'ssh', default: 'session' } },
		{ key: 'sshPort', label: 'SSH port', type: 'number', min: 1, max: 65535, placeholder: '22', showWhen: { key: 'connection', equals: 'ssh', default: 'session' } },
		{
			key: 'scope', label: 'Domains of', type: 'select', default: 'system', showWhen: { key: 'connection', equals: 'ssh', default: 'session' },
			options: [{ value: 'system', label: 'The system (qemu:///system)' }, { value: 'session', label: 'The SSH user (qemu:///session)' }]
		},
		{ key: 'uri', label: 'URI', type: 'text', required: true, placeholder: 'qemu+ssh://user@host/system', showWhen: { key: 'connection', equals: 'custom', default: 'session' } },
		{ key: 'virshPath', label: 'virsh program', type: 'file', advanced: true, description: 'Leave empty to find virsh on PATH and in the usual install folders.' },
		{ key: 'shutdownTimeout', label: 'Shut down timeout', type: 'number', default: 30, min: 5, max: 600, unit: 's', advanced: true, description: 'How long a graceful shut down waits for the guest before offering to power off.' }
	];

	constructor(private readonly runner: Runner = execRunner, private readonly locate: (configured?: string) => string | undefined = findVirsh) {}

	defaultClusterName(): string { return 'libvirt'; }
	remoteLabel(cluster: ClusterConfig): string | undefined { return remoteLabel(cluster.config); }

	async testConnection(cluster: ClusterConfig, secrets: SecretBag, context: ProviderContext): Promise<void> {
		(await this.connect(cluster, secrets, context)).dispose();
	}

	async connect(cluster: ClusterConfig, _secrets: SecretBag, context: ProviderContext): Promise<LibvirtConnection> {
		const uri = buildUri(cluster.config);
		const binary = this.locate(String(cluster.config.virshPath ?? ''));
		if (!binary) {
			throw new ProviderError('virsh was not found. Install libvirt (macOS: `brew install libvirt`; Debian/Ubuntu: `apt install libvirt-clients`; Fedora: `dnf install libvirt-client`) or set the path to virsh in the cluster settings.', 'unavailable');
		}
		const timeout = Number(cluster.config.shutdownTimeout ?? 30);
		const connection = new LibvirtConnection(new Virsh(binary, uri, this.runner), uri, context.log, Number.isFinite(timeout) ? timeout : 30);
		// Connecting is the first real call: a wrong URI, a stopped daemon or a refused login shows now.
		await connection.listNodes();
		return connection;
	}
}

interface Cached { at: number; state: string; domain: DomainInfo }

export class LibvirtConnection implements ClusterConnection {
	readonly capabilities: Capabilities = {
		create: false, edit: false, delete: true,
		power: ['start', 'shutdown', 'reboot', 'stop', 'reset'] as PowerAction[],
		consoles: ['vnc', 'serial'] as ConsoleKind[],
		preview: false, external: false, media: true, details: true, stats: true, snapshots: true
	};
	private readonly local: boolean;
	private readonly ssh;
	private facts: { at: number; info: NodeInfo } | undefined;
	private readonly domains = new Map<string, Cached>();
	private readonly byId = new Map<string, string>();
	private readonly addresses = new Map<string, { at: number; byMac: Map<string, string[]> }>();
	private readonly cpuSamples = new Map<string, { at: number; cpuNs: number }>();

	constructor(private readonly virsh: Virsh, private readonly uri: string, private readonly log: Logger, private readonly shutdownTimeoutSeconds = 30) {
		this.local = isLocalUri(uri);
		this.ssh = sshTarget(uri);
	}

	dispose(): void { this.domains.clear(); this.byId.clear(); this.addresses.clear(); this.cpuSamples.clear(); }

	// -----------------------------------------------------------------------------------------
	// Inventory
	// -----------------------------------------------------------------------------------------

	async listNodes(): Promise<NodeInfo[]> {
		if (!this.facts || Date.now() - this.facts.at > 5 * 60_000) {
			const [version, nodeinfo, hostname] = await Promise.all([
				this.virsh.exec(['version']),
				this.virsh.exec(['nodeinfo']),
				this.virsh.exec(['hostname']).catch(() => '')
			]);
			const { library, hypervisor } = parseVersion(version);
			const node = parseNodeinfo(nodeinfo);
			this.facts = {
				at: Date.now(),
				info: {
					id: NODE_ID, name: hostname.trim() || (this.ssh?.host ?? 'This computer'), status: 'online',
					cpus: node.cpus, memoryMB: node.memoryMB,
					facts: [
						{ label: 'Connection', value: this.uri.replace(/\?.*$/, '') },
						...(library ? [{ label: 'libvirt', value: library }] : []),
						...(hypervisor ? [{ label: 'Hypervisor', value: hypervisor }] : []),
						...(node.model ? [{ label: 'CPU', value: node.model }] : [])
					]
				}
			};
		}
		return [this.facts.info];
	}

	async listVms(_nodeId: string): Promise<VmInfo[]> {
		const stats = parseDomstats(await this.virsh.exec(['domstats', '--list-active', '--list-inactive', '--state']));
		const processes = this.local ? await sampleProcesses() : new Map<string, QemuProcess>();
		const seen = new Set<string>();
		const vms = await Promise.all([...stats].map(async ([name, s]) => {
			if (name.startsWith('-')) { this.log.warn(`Skipping domain "${name}": its name looks like an option.`); return undefined; }
			const state = stateOf(s);
			const domain = await this.domain(name, String(state));
			if (!domain.uuid) return undefined;
			seen.add(domain.uuid);
			this.byId.set(domain.uuid, name);
			const running = state === 'running' || state === 'paused';
			const ips = state === 'running' ? [...(await this.guestAddresses(domain)).values()].flat() : [];
			return {
				id: domain.uuid, name, state,
				cpus: domain.vcpus, memoryMB: domain.memoryMB,
				...(running && processes.get(name)?.uptimeSeconds !== undefined ? { uptimeSeconds: processes.get(name)!.uptimeSeconds } : {}),
				...(ips.length ? { ipAddresses: ips } : {}),
				...(domain.nics.some((n) => n.mac) ? { macAddresses: domain.nics.flatMap((n) => (n.mac ? [n.mac] : [])) } : {}),
				...(domain.arch ? { os: domain.arch } : {}),
				consoles: this.consolesOf(domain),
				mediaInserted: domain.disks.some((d) => d.device === 'cdrom' && !!d.path)
			} satisfies VmInfo;
		}));
		for (const [uuid, name] of this.byId) if (!seen.has(uuid)) { this.byId.delete(uuid); this.domains.delete(name); this.addresses.delete(uuid); this.cpuSamples.delete(uuid); }
		return vms.filter((v): v is NonNullable<typeof v> => !!v);
	}

	private consolesOf(domain: DomainInfo): ConsoleKind[] {
		const consoles: ConsoleKind[] = [];
		if (domain.graphics.some((g) => g.type === 'vnc')) consoles.push('vnc');
		if (domain.serial && (this.local || domain.serial.kind === 'tcp')) consoles.push('serial');
		return consoles;
	}

	/** The definition changes rarely: keep it a minute, and re-read it when the state changes. */
	private async domain(name: string, state: string): Promise<DomainInfo> {
		const cached = this.domains.get(name);
		if (cached && cached.state === state && Date.now() - cached.at < 60_000) return cached.domain;
		const domain = parseDomain(await this.virsh.exec(['dumpxml', name]));
		this.domains.set(name, { at: Date.now(), state, domain });
		return domain;
	}

	private async freshDomain(vmId: string, securityInfo = false): Promise<DomainInfo> {
		return parseDomain(await this.virsh.exec(['dumpxml', ...(securityInfo ? ['--security-info'] : []), assertId(vmId)]));
	}

	/** Addresses by MAC, from the DHCP leases or the guest agent. Cached: it costs a process per domain. */
	private async guestAddresses(domain: DomainInfo): Promise<Map<string, string[]>> {
		const cached = this.addresses.get(domain.uuid);
		if (cached && Date.now() - cached.at < 30_000) return cached.byMac;
		const byMac = new Map<string, string[]>();
		for (const source of domain.agent ? ['agent', 'lease'] : ['lease']) {
			const output = await this.virsh.exec(['domifaddr', domain.uuid, '--source', source], 10_000).catch(() => '');
			for (const { mac, address } of parseDomifaddr(output)) {
				if (address.toLowerCase().startsWith('fe80') || address === '127.0.0.1' || address === '::1') continue;
				byMac.set(mac, [...(byMac.get(mac) ?? []), address]);
			}
			if (byMac.size) break;
		}
		this.addresses.set(domain.uuid, { at: Date.now(), byMac });
		return byMac;
	}

	async getVmDetails(_nodeId: string, vmId: string): Promise<VmDetails> {
		const id = assertId(vmId);
		const domain = await this.freshDomain(id);
		const state = (await this.virsh.exec(['domstate', id])).trim();
		const capacities = new Map<string, number>();
		await Promise.all(domain.disks.filter((d) => d.device === 'disk' && d.path && DISK_TARGET.test(d.target)).map(async (disk) => {
			const info = await this.virsh.exec(['domblkinfo', id, disk.target], 10_000).catch(() => '');
			const capacity = /^Capacity:\s+(\d+)/m.exec(info)?.[1];
			if (capacity) capacities.set(disk.target, Number(capacity));
		}));
		const addresses = state === 'running' ? await this.guestAddresses(domain) : new Map<string, string[]>();
		return { disks: toDiskDevices(domain, capacities), nics: toNicDevices(domain, addresses), devices: [], forwards: [] };
	}

	async getVmStats(_nodeId: string, vmId: string): Promise<VmStats> {
		const id = assertId(vmId);
		const output = await this.virsh.exec(['domstats', id, '--state', '--cpu-total', '--balloon', '--block', '--interface']);
		const [name, s] = [...parseDomstats(output)][0] ?? [undefined, undefined];
		const at = Date.now();
		if (!name || !s) throw new ProviderError('The domain no longer exists.', 'notFound');
		const memoryMB = s['balloon.maximum'] ? Math.round(Number(s['balloon.maximum']) / 1024) : undefined;
		const state = stateOf(s);
		if (state !== 'running' && state !== 'paused') { this.cpuSamples.delete(id); return { timestamp: at, memoryMB }; }
		const vcpus = (this.domains.get(name)?.domain.vcpus) ?? Number(s['vcpu.current'] ?? 1) ?? 1;
		let cpuUsage: number | undefined;
		let memoryUsedMB = s['balloon.rss'] && Number(s['balloon.rss']) > 0 ? Math.round(Number(s['balloon.rss']) / 1024) : undefined;
		let uptimeSeconds: number | undefined;
		const cpuNs = Number(s['cpu.time'] ?? 0);
		if (cpuNs > 0) {
			const previous = this.cpuSamples.get(id);
			this.cpuSamples.set(id, { at, cpuNs });
			if (previous && at > previous.at) cpuUsage = Math.min(1, Math.max(0, (cpuNs - previous.cpuNs) / ((at - previous.at) * 1e6) / Math.max(1, vcpus)));
		}
		if (this.local && (cpuUsage === undefined || memoryUsedMB === undefined)) {
			// No cgroups (macOS) or no balloon figure: look at the QEMU process itself.
			const process_ = (await sampleProcesses()).get(name);
			if (process_) {
				cpuUsage ??= Math.min(1, process_.cpuPercent / 100 / Math.max(1, vcpus));
				memoryUsedMB ??= process_.rssMB;
				uptimeSeconds = process_.uptimeSeconds;
			}
		}
		const blocks = blockStats(s).filter((b) => !b.name.startsWith('-'));
		const disks: DiskStats[] = blocks.map((b) => ({ id: b.name, readBytes: b.readBytes, writeBytes: b.writeBytes, readOps: b.readOps, writeOps: b.writeOps, readTimeNs: b.readTimeNs, writeTimeNs: b.writeTimeNs, flushOps: b.flushOps, flushTimeNs: b.flushTimeNs }));
		return { timestamp: at, uptimeSeconds, cpuUsage, memoryUsedMB, memoryMB, disks, network: netStats(s) };
	}

	// -----------------------------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------------------------

	async getCreateSchema(): Promise<FieldSchema[]> { throw this.noCreate(); }
	async createVm(): Promise<VmInfo> { throw this.noCreate(); }
	async getVmConfig(): Promise<VmConfig> { throw new ProviderError('Domains are edited with virsh edit, virt-manager or Cockpit.', 'unsupported'); }
	async updateVm(): Promise<void> { throw new ProviderError('Domains are edited with virsh edit, virt-manager or Cockpit.', 'unsupported'); }
	private noCreate(): ProviderError { return new ProviderError('Creating domains is not available yet: define one with virt-install, virt-manager or `virsh define`, and it appears here.', 'unsupported'); }

	async power(_nodeId: string, vmId: string, action: PowerAction): Promise<void> {
		const id = assertId(vmId);
		switch (action) {
			case 'start': await this.virsh.exec(['start', id], 120_000); break;
			case 'stop': await this.virsh.exec(['destroy', id]); break;
			case 'reset': await this.virsh.exec(['reset', id]); break;
			case 'reboot': await this.virsh.exec(['reboot', id]); break;
			case 'shutdown': {
				await this.virsh.exec(['shutdown', id]);
				const deadline = Date.now() + this.shutdownTimeoutSeconds * 1000;
				while (Date.now() < deadline) {
					await delay(1000);
					if ((await this.virsh.exec(['domstate', id]).catch(() => 'shut off')).trim() === 'shut off') return;
				}
				throw new ProviderError(`The guest did not shut down within ${this.shutdownTimeoutSeconds} seconds. It may have no ACPI or guest agent support.`, 'timeout');
			}
		}
		this.addresses.delete(id);
		this.cpuSamples.delete(id);
	}

	async deleteVm(_nodeId: string, vmId: string, options: DeleteOptions): Promise<void> {
		const id = assertId(vmId);
		const domain = await this.freshDomain(id);
		// Only volumes of a storage pool can be removed by libvirt; any other file is ours to delete, and only on this computer.
		const managed: string[] = [];
		const loose: string[] = [];
		if (options.deleteDisks) {
			for (const disk of domain.disks.filter((d) => d.device === 'disk' && d.path && DISK_TARGET.test(d.target))) {
				const isVolume = await this.virsh.exec(['vol-info', '--', disk.path!], 10_000).then(() => true, () => false);
				(isVolume ? managed : loose).push(isVolume ? disk.target : disk.path!);
			}
			if (loose.length && !this.local) {
				throw new ProviderError(`libvirt cannot remove ${loose.join(', ')} on the host: it is not in a storage pool. Delete the domain without its disks and remove the files there.`, 'unsupported');
			}
		}
		const state = (await this.virsh.exec(['domstate', id])).trim();
		if (state !== 'shut off') await this.virsh.exec(['destroy', id]);
		await this.virsh.exec(['undefine', id, '--nvram', '--managed-save', '--snapshots-metadata', ...(managed.length ? ['--storage', managed.join(',')] : [])], 60_000);
		for (const file of loose) await rm(file, { force: true }).catch((e: Error) => this.log.warn(`Could not remove ${file}: ${e.message}`));
	}

	// -----------------------------------------------------------------------------------------
	// Media
	// -----------------------------------------------------------------------------------------

	private async changeMedia(vmId: string, device: string, imagePath: string | undefined): Promise<void> {
		const id = assertId(vmId);
		if (!DISK_TARGET.test(device)) throw new ProviderError('Invalid drive.', 'invalid');
		if (imagePath !== undefined && !/^(\/|[A-Za-z]:[\\/])/.test(imagePath)) throw new ProviderError('Give the image as an absolute path on the libvirt host.', 'invalid');
		// A running domain changes live and keeps the change; a stopped one only its definition.
		const running = (await this.virsh.exec(['domstate', id])).trim() === 'running';
		const where = running ? ['--live', '--config'] : ['--config'];
		await this.virsh.exec(['change-media', id, device, ...(imagePath === undefined ? ['--eject', '--force'] : [imagePath, '--update']), ...where]);
		this.domains.clear();
	}
	ejectMedia(_nodeId: string, vmId: string, deviceId: string): Promise<void> { return this.changeMedia(vmId, deviceId, undefined); }
	insertMedia(_nodeId: string, vmId: string, deviceId: string, imagePath: string): Promise<void> { return this.changeMedia(vmId, deviceId, imagePath); }

	// -----------------------------------------------------------------------------------------
	// Snapshots
	// -----------------------------------------------------------------------------------------

	async listSnapshots(_nodeId: string, vmId: string): Promise<Snapshot[]> {
		const id = assertId(vmId);
		const names = (await this.virsh.exec(['snapshot-list', id, '--name'])).split(/\r?\n/).map((n) => n.trim()).filter((n) => SNAPSHOT_NAME.test(n));
		const snapshots = await Promise.all(names.map(async (name) => parseSnapshot(await this.virsh.exec(['snapshot-dumpxml', id, name]))));
		return snapshots.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
	}

	async createSnapshot(_nodeId: string, vmId: string, name: string): Promise<Snapshot> {
		const id = assertId(vmId);
		if (!SNAPSHOT_NAME.test(name)) throw new ProviderError('A snapshot name starts with a letter or digit and has up to 64 letters, digits, "-", "_" or ".".', 'invalid');
		try {
			await this.virsh.exec(['snapshot-create-as', id, '--name', name], 10 * 60_000);
		} catch (error) {
			if (error instanceof Error && /pflash/i.test(error.message)) {
				throw new ProviderError('libvirt cannot snapshot a UEFI domain whose firmware variables are a raw file (it needs a qcow2 nvram, which this host\'s firmware does not offer). Snapshot the disks with qemu-img while it is off, or use a domain without UEFI.', 'unsupported');
			}
			throw error;
		}
		return parseSnapshot(await this.virsh.exec(['snapshot-dumpxml', id, name]));
	}

	async revertSnapshot(_nodeId: string, vmId: string, snapshotId: string): Promise<void> {
		if (!SNAPSHOT_NAME.test(snapshotId)) throw new ProviderError('Invalid snapshot.', 'invalid');
		await this.virsh.exec(['snapshot-revert', assertId(vmId), snapshotId], 10 * 60_000);
		this.addresses.delete(vmId);
	}

	async deleteSnapshot(_nodeId: string, vmId: string, snapshotId: string): Promise<void> {
		if (!SNAPSHOT_NAME.test(snapshotId)) throw new ProviderError('Invalid snapshot.', 'invalid');
		await this.virsh.exec(['snapshot-delete', assertId(vmId), snapshotId], 10 * 60_000);
	}

	// -----------------------------------------------------------------------------------------
	// Consoles
	// -----------------------------------------------------------------------------------------

	async openConsole(_nodeId: string, vmId: string, kind: ConsoleKind): Promise<ConsoleStream> {
		const id = assertId(vmId);
		const state = (await this.virsh.exec(['domstate', id])).trim();
		if (state !== 'running' && state !== 'paused') throw new ProviderError('The domain is not running.', 'unavailable');
		const domain = await this.freshDomain(id, kind === 'vnc');
		if (kind === 'vnc') {
			const graphics = domain.graphics.find((g) => g.type === 'vnc');
			if (!graphics) throw new ProviderError(domain.graphics.some((g) => g.type === 'spice') ? 'This domain uses SPICE, which VM Manager cannot show. Add a VNC display to it.' : 'This domain has no VNC display.', 'unavailable');
			if (graphics.socket && !this.ssh) return { ...(await openEndpoint({ path: graphics.socket }, undefined, 'display')), ...(graphics.passwd ? { credentials: { password: graphics.passwd } } : {}) };
			let port = graphics.port;
			let host = graphics.listen;
			if (!port) {
				const found = parseVncDisplay(await this.virsh.exec(['vncdisplay', id]));
				if (!found) throw new ProviderError('libvirt did not report where the VNC display listens.', 'unavailable');
				({ port, host } = { port: found.port, host: found.host });
			}
			if (!host || host === '0.0.0.0' || host === '::') host = '127.0.0.1';
			const stream = await openEndpoint({ host, port }, this.ssh, 'display');
			return { ...stream, ...(graphics.passwd ? { credentials: { password: graphics.passwd } } : {}) };
		}
		const serial = domain.serial;
		if (!serial) throw new ProviderError('This domain has no serial port VM Manager can use. Add a pty, unix socket or TCP serial device.', 'unavailable');
		if (serial.kind === 'pty') {
			if (this.ssh || !this.local) throw new ProviderError(`The serial console is a terminal on the host (${serial.path}); use \`virsh console\` there, or give the domain a TCP serial port.`, 'unsupported');
			if (!serial.path) throw new ProviderError('libvirt has not allocated the serial terminal yet. Try again in a moment.', 'unavailable');
			return openPty(serial.path);
		}
		return openEndpoint(serial.kind === 'unix' ? { path: serial.path } : { host: serial.host, port: serial.port }, this.ssh, 'serial console');
	}
}
