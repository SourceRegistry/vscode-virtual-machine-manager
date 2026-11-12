import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	ProviderError, type Capabilities, type ClusterConfig, type ClusterConnection, type ConsoleKind, type ConsoleStream, type DeleteOptions,
	type DiskStats, type FieldSchema, type FieldValues, type HypervisorProvider, type Logger, type NodeInfo, type PowerAction, type ProviderContext,
	type CreateProgress, type GuestCommand, type GuestCommandResult, type PortForward, type SecretBag, type TransferProgress, type Snapshot, type VmConfig, type VmDetails, type VmInfo, type VmStats
} from '@vmm/sdk';
import {
	buildIso, cloudFields, cloudInitProblem, ensureImage, findImage, hostnameFor, localImageHost, metaData, parseKeys, sha512Crypt, SOURCE_ISO, userData, type Arch, type DownloadProgress
} from '@vmm/sdk/provisioning';
import { copyFromGuest, copyToGuest, explainAgentError, runInGuest, type AgentCall } from '@vmm/sdk/guest';
import { openEndpoint, openPty } from './consoles';
import { activeForwards, checkHmp, forwardsMetadata, hostfwdKey, hostfwdRule, METADATA_URI, normalizeForward, parseForwardsMetadata, sameHostPort, userNetdev } from './forwards';
import { buildDomainXml, DISK_BUSES, NAME, parseDomainCapabilities, type DiskBus } from './definition';
import {
	blockStats, guestMemoryUsedMB, netStats, parseDomain, parseDomifaddr, parseDomstats, parseNodeinfo, parseSnapshot, parseVersion, parseVncDisplay, stateOf, toDiskDevices, toNicDevices, UUID,
	type DomainInfo
} from './parse';
import { sampleProcesses, type QemuProcess } from './process';
import { buildUri, isLocalUri, remoteLabel, sshTarget } from './uri';
import { execRunner, findVirsh, Virsh, type Runner } from './virsh';

const NODE_ID = 'host';
/**
 * Bytes per `guest-file-write` through libvirt. A request to the agent of about 8 KB or more arrives cut
 * short ("JSON parse error", then the agent stops answering for a while): found on libvirt 12.9 / QEMU 11.1
 * (macOS session), where 5 KiB worked and 6 KiB did not. QEMU's own agent socket takes 1 MiB.
 */
const AGENT_WRITE_CHUNK = 4 * 1024;
/** Bytes per `guest-file-read`: answers come back on virsh's stdout, which has no such limit. */
const AGENT_READ_CHUNK = 1024 * 1024;
const SNAPSHOT_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const DISK_TARGET = /^[a-z0-9]{1,16}$/;

/** The cloud-init seed volume of a domain made from a cloud image (see createFromCloudImage). */
const isSeed = (file: string | undefined): boolean => !!file && /-cidata\.iso$/.test(file);

/** `qcow2` when the file starts with the qcow2 magic, else `raw` (the formats cloud images ship in). */
async function imageFormat(file: string): Promise<'qcow2' | 'raw'> {
	const handle = await open(file, 'r');
	try {
		const magic = Buffer.alloc(4);
		await handle.read(magic, 0, 4, 0);
		return magic.equals(Buffer.from([0x51, 0x46, 0x49, 0xfb])) ? 'qcow2' : 'raw';
	} finally {
		await handle.close();
	}
}

async function statSize(file: string): Promise<number> {
	const handle = await open(file, 'r');
	try {
		return (await handle.stat()).size;
	} finally {
		await handle.close();
	}
}

/** Format and capacity (bytes) from `vol-dumpxml`. */
export function parseVolumeXml(xml: string): { format?: string; capacity?: number } {
	const format = /<target>[\s\S]*?<format type='([^']+)'/.exec(xml)?.[1];
	const capacity = /<capacity unit='bytes'>(\d+)<\/capacity>/.exec(xml)?.[1];
	return { ...(format ? { format } : {}), ...(capacity ? { capacity: Number(capacity) } : {}) };
}

/** Download progress as create progress between `from` and `to`. */
function downloadProgress(label: string, from: number, to: number, progress?: (update: CreateProgress) => void) {
	return (p: DownloadProgress) => {
		const fraction = p.done !== undefined && p.total ? from + ((to - from) * p.done) / p.total : undefined;
		const message =
			p.phase === 'download' ? `Downloading ${label}${p.total && p.done !== undefined ? ` — ${Math.round((100 * p.done) / p.total)}%` : ''}`
			: p.phase === 'verify' ? 'Verifying the checksum'
			: p.phase === 'checksum' ? 'Checking for the latest image'
			: 'Using the downloaded image';
		progress?.({ message, fraction });
	};
}

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
		const connection = new LibvirtConnection(new Virsh(binary, uri, this.runner), uri, context.log, Number.isFinite(timeout) ? timeout : 30, join(context.storagePath, 'images'));
		// Connecting is the first real call: a wrong URI, a stopped daemon or a refused login shows now.
		await connection.listNodes();
		return connection;
	}
}

interface Cached { at: number; state: string; domain: DomainInfo }

export class LibvirtConnection implements ClusterConnection {
	readonly capabilities: Capabilities = {
		create: true, edit: false, delete: true,
		power: ['start', 'shutdown', 'reboot', 'stop', 'reset'] as PowerAction[],
		consoles: ['vnc', 'serial'] as ConsoleKind[],
		preview: false, external: false, media: true, details: true, stats: true, snapshots: true, remotePaths: false,
		guestExec: true, guestFiles: true
	};
	private readonly local: boolean;
	private readonly ssh;
	private facts: { at: number; info: NodeInfo } | undefined;
	private readonly domains = new Map<string, Cached>();
	private readonly byId = new Map<string, string>();
	private readonly addresses = new Map<string, { at: number; byMac: Map<string, string[]> }>();
	private readonly cpuSamples = new Map<string, { at: number; cpuNs: number }>();

	/**
	 * @param imageDirectory Cloud images are downloaded and verified here, on this computer, and uploaded
	 *   into a storage pool through libvirt (over its own SSH connection for a remote host).
	 */
	constructor(private readonly virsh: Virsh, private readonly uri: string, private readonly log: Logger, private readonly shutdownTimeoutSeconds = 30, private readonly imageDirectory = join(tmpdir(), 'vmm-libvirt-images')) {
		this.local = isLocalUri(uri);
		this.ssh = sshTarget(uri);
		// Installer images are read by libvirt on its own host: from another computer a file dialog here would pick the wrong file.
		this.capabilities.remotePaths = !this.local;
		// A forward listens on the libvirt host: only on this computer is that where Remote-SSH connects.
		this.capabilities.forwards = this.local;
		this.capabilities.shutdownTimeoutSeconds = shutdownTimeoutSeconds;
	}

	/**
	 * libvirt's log of a domain (QEMU's command line and output), which libvirt keeps on its own host: readable
	 * here for a connection on this computer, the session's in ~/.cache, the system's in /var/log (often root only).
	 */
	async readVmLog(_nodeId: string, vmId: string): Promise<string | undefined> {
		if (!this.local) return undefined;
		const name = this.byId.get(vmId);
		if (!name || name.includes('/')) return undefined;
		const dir = this.uri.includes('/session') ? join(homedir(), '.cache', 'libvirt', 'qemu', 'log') : '/var/log/libvirt/qemu';
		return readFile(join(dir, `${name}.log`), 'utf8').catch(() => undefined);
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
				mediaInserted: domain.disks.some((d) => d.device === 'cdrom' && !!d.path),
				...(domain.virtType === 'qemu' ? { emulated: true } : {})
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
		const forwards = this.local && domain.nics.some((n) => n.type === 'user') ? await this.savedForwards(id) : [];
		// A domain started outside VS Code (virsh, virt-manager) has none of them yet.
		if (forwards.length && state === 'running') await this.applyForwards(id, forwards);
		return { disks: toDiskDevices(domain, capacities), nics: toNicDevices(domain, addresses), devices: [], forwards };
	}

	// -----------------------------------------------------------------------------------------
	// Guest agent: commands and files (virsh qemu-agent-command; libvirt notes the domain as tainted)
	// -----------------------------------------------------------------------------------------

	/**
	 * A call into the guest agent of a running domain: one virsh process per call, the request JSON as an argument.
	 */
	private async agent(vmId: string): Promise<AgentCall> {
		const id = assertId(vmId);
		if ((await this.virsh.exec(['domstate', id])).trim() !== 'running') throw new ProviderError('Start the machine first.', 'invalid');
		return async <T,>(command: string, args?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> => {
			const request = JSON.stringify(args ? { execute: command, arguments: args } : { execute: command });
			let output: string;
			try {
				output = await this.virsh.exec(['qemu-agent-command', id, request, '--timeout', String(Math.max(1, Math.ceil(timeoutMs / 1000)))], timeoutMs + 10_000);
			} catch (error) {
				throw explainAgentError(error);
			}
			return (JSON.parse(output) as { return: T }).return;
		};
	}

	async runInGuest(_nodeId: string, vmId: string, command: GuestCommand): Promise<GuestCommandResult> {
		return runInGuest(await this.agent(vmId), command);
	}

	async copyToGuest(_nodeId: string, vmId: string, localPath: string, guestPath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
		await copyToGuest(await this.agent(vmId), localPath, guestPath, { chunkSize: AGENT_WRITE_CHUNK, onProgress });
	}

	async copyFromGuest(_nodeId: string, vmId: string, guestPath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
		await copyFromGuest(await this.agent(vmId), guestPath, localPath, { chunkSize: AGENT_READ_CHUNK, onProgress });
	}

	// -----------------------------------------------------------------------------------------
	// Port forwards (user-mode networking; see forwards.ts)
	// -----------------------------------------------------------------------------------------

	private async savedForwards(id: string): Promise<PortForward[]> {
		// No element yet is an error from virsh: it means no forwards.
		return parseForwardsMetadata(await this.virsh.exec(['metadata', id, '--uri', METADATA_URI, '--config']).catch(() => ''));
	}

	private async saveForwards(id: string, forwards: PortForward[]): Promise<void> {
		if (forwards.length) await this.virsh.exec(['metadata', id, '--uri', METADATA_URI, '--key', 'vmm', '--set', forwardsMetadata(forwards), '--config']);
		else await this.virsh.exec(['metadata', id, '--uri', METADATA_URI, '--remove', '--config']).catch(() => undefined);
	}

	private async hmp(id: string, command: string, what: string): Promise<string> {
		return checkHmp(await this.virsh.exec(['qemu-monitor-command', id, '--hmp', command]), what);
	}

	/** Adds the saved forwards QEMU does not have yet; a port another program took is logged, not fatal. */
	private async applyForwards(id: string, forwards: PortForward[]): Promise<void> {
		const netdev = userNetdev(await this.hmp(id, 'info network', 'Could not read the network'));
		if (!netdev) return;
		const active = activeForwards(await this.hmp(id, 'info usernet', 'Could not read the forwards'));
		for (const f of forwards.filter((f) => !active.some((a) => sameHostPort(a, f)))) {
			await this.hmp(id, `hostfwd_add ${netdev} ${hostfwdRule(f)}`, `Could not forward ${f.hostPort}`).catch((e: Error) => this.log.warn(e.message));
		}
	}

	private async forwardTarget(vmId: string) {
		const id = assertId(vmId);
		if (!this.local) throw new ProviderError('Port forwards are only available for domains on this computer.', 'unsupported');
		const domain = await this.freshDomain(id);
		if (!domain.nics.some((n) => n.type === 'user')) {
			throw new ProviderError('Port forwards are for user-mode networking. On a libvirt network the guest has its own address: connect to that.', 'unsupported');
		}
		const running = (await this.virsh.exec(['domstate', id])).trim() === 'running';
		return { id, running, saved: await this.savedForwards(id) };
	}

	async addPortForward(_nodeId: string, vmId: string, forward: PortForward): Promise<void> {
		const f = normalizeForward(forward);
		const { id, running, saved } = await this.forwardTarget(vmId);
		if (saved.some((s) => sameHostPort(s, f))) throw new ProviderError(`Port ${f.hostPort} is already forwarded.`, 'invalid');
		if (running) {
			const netdev = userNetdev(await this.hmp(id, 'info network', 'Could not read the network'));
			if (!netdev) throw new ProviderError('The running domain has no user-mode network to forward from.', 'unsupported');
			await this.hmp(id, `hostfwd_add ${netdev} ${hostfwdRule(f)}`, `Could not forward port ${f.hostPort} (is it in use?)`);
		}
		await this.saveForwards(id, [...saved, f]);
	}

	async removePortForward(_nodeId: string, vmId: string, forward: PortForward): Promise<void> {
		const f = normalizeForward(forward);
		const { id, running, saved } = await this.forwardTarget(vmId);
		if (running) {
			const netdev = userNetdev(await this.hmp(id, 'info network', 'Could not read the network'));
			if (netdev) await this.hmp(id, `hostfwd_remove ${netdev} ${hostfwdKey(f)}`, `Could not remove the forward of port ${f.hostPort}`).catch((e: Error) => this.log.warn(e.message));
		}
		await this.saveForwards(id, saved.filter((s) => !sameHostPort(s, f)));
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
		const guestMB = guestMemoryUsedMB(s);
		if (guestMB === undefined && state === 'running') await this.enableBalloonStats(id);
		let memoryUsedMB = guestMB ?? (s['balloon.rss'] && Number(s['balloon.rss']) > 0 ? Math.round(Number(s['balloon.rss']) / 1024) : undefined);
		const memorySource = guestMB !== undefined ? ('guest' as const) : ('host' as const);
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
		return { timestamp: at, uptimeSeconds, cpuUsage, memoryUsedMB, memorySource, memoryMB, disks, network: netStats(s) };
	}

	/** When each domain was last asked for balloon statistics; a domain without the driver is asked again after a minute. */
	private readonly balloonAsked = new Map<string, number>();

	/** Turns on the balloon driver's statistics for a running domain (domains made elsewhere have no period). */
	private async enableBalloonStats(id: string): Promise<void> {
		const asked = this.balloonAsked.get(id);
		if (asked !== undefined && Date.now() - asked < 60_000) return;
		this.balloonAsked.set(id, Date.now());
		await this.virsh.exec(['dommemstat', id, '--period', '5', '--live'], 10_000).catch(() => undefined);
	}

	// -----------------------------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------------------------

	/** Names a command lists, one per line (`pool-list --name`); empty when the driver lacks the object. */
	private async names(args: string[]): Promise<string[]> {
		return (await this.virsh.exec(args).catch(() => '')).split(/\r?\n/).map((n) => n.trim()).filter((n) => n && !n.startsWith('-'));
	}

	async getCreateSchema(_nodeId?: string): Promise<FieldSchema[]> {
		const [pools, networks, host, [node], cached] = await Promise.all([
			this.names(['pool-list', '--type', 'dir', '--name']),
			this.names(['net-list', '--name']),
			this.hostCapabilities(),
			this.listNodes(),
			readdir(this.imageDirectory).then((files) => new Set(files.filter((f) => f.endsWith('.verified')).map((f) => f.slice(0, -'.verified'.length))), () => new Set<string>())
		]);
		// Catalog images exist for the two architectures libvirt hosts usually run; another host gets a file only.
		const installed: Arch[] = host.arch === 'x86_64' || host.arch === 'aarch64' ? [host.arch] : [];
		const arm = host.arch === 'aarch64';
		const poolPath = this.newPoolPath();
		const canMakePool = !!poolPath && !pools.length;
		const bus = (value: DiskBus, label: string, description: string) => ({ value, label, description });
		return [
			{ key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'my-vm', description: 'Letters, digits, "." "_" and "-"; it starts with a letter or digit.' },
			{
				key: 'source', label: 'Set up from', type: 'select', required: true, default: 'iso',
				options: [
					{ value: 'iso', label: 'An installer ISO', description: 'Install the operating system yourself' },
					{ value: 'cloud', label: 'A cloud image (cloud-init)', description: this.local ? 'Debian or Ubuntu, ready in a minute: no installer' : 'Debian or Ubuntu: downloaded here, uploaded to the host through libvirt' }
				]
			},
			{ key: 'cpus', label: 'Processors', type: 'number', unit: 'cores', min: 1, max: node?.cpus ?? 64, default: Math.min(2, node?.cpus ?? 2), required: true },
			{ key: 'memoryMB', label: 'Memory', type: 'number', unit: 'MB', min: 128, default: 2048, required: true },
			{ key: 'diskGB', label: 'Disk size', type: 'number', unit: 'GB', min: 1, max: 16384, default: 32, required: true, description: 'A thin qcow2 volume: it only takes the space the guest uses.' },
			{ key: 'iso', label: 'Installation media (ISO)', type: 'file', remotePath: !this.local, showWhen: SOURCE_ISO, filters: { 'Disk images': ['iso', 'img'] }, description: this.local ? undefined : 'The path on the libvirt host.' },
			{
				key: 'pool', label: 'Storage pool', type: 'select', required: !canMakePool, default: pools.includes('default') ? 'default' : (pools[0] ?? ''),
				options: pools.length ? pools.map((p) => ({ value: p, label: p })) : canMakePool ? [{ value: '', label: `New pool in ${poolPath}`, description: 'This connection has no directory pool yet.' }] : [],
				description: pools.length || canMakePool ? 'Where the disk is created.' : 'This libvirt has no directory storage pool: create one on the host (virsh pool-define-as) first.'
			},
			// The image file is on this computer whichever host libvirt runs on: it is uploaded into the pool.
			...cloudFields({ installed, remote: false, cached }),
			{
				key: 'network', label: 'Network', type: 'select', required: true, default: networks.includes('default') ? 'default' : 'user',
				options: [...networks.map((n) => ({ value: n, label: `Network "${n}"` })), { value: 'user', label: 'User-mode (NAT, no setup)', description: 'The guest reaches out; nothing reaches the guest.' }]
			},
			...(arm || !host.efi ? [] : [{ key: 'firmware', label: 'Firmware', type: 'select' as const, required: true, default: 'bios', options: [{ value: 'bios', label: 'BIOS' }, { value: 'uefi', label: 'UEFI' }] }]),
			{
				key: 'diskBus', label: 'Disk controller', type: 'select', required: true, default: 'virtio', advanced: true,
				options: [
					bus('virtio', 'VirtIO', 'Fastest; Linux has the driver, Windows needs the virtio drivers.'),
					bus('scsi', 'VirtIO SCSI', 'Fast, and discards freed space.'),
					...(arm ? [] : [bus('sata', 'SATA', 'Works with every installer.')])
				]
			}
		];
	}

	/** What the host's default emulator offers; the first thing a new domain is built from. */
	private async hostCapabilities() {
		const first = parseDomainCapabilities(await this.virsh.exec(['domcapabilities']));
		// The default machine can be an odd one (Debian's libvirt picks `integratorcp` on ARM, one CPU, no PCI): ask for the usual one.
		const wanted = first.arch === 'aarch64' ? 'virt' : first.arch === 'x86_64' ? 'q35' : undefined;
		if (!wanted || first.machine.startsWith(wanted) || first.machine.startsWith(`pc-${wanted}`)) return first;
		const asked = parseDomainCapabilities(await this.virsh.exec(['domcapabilities', '--machine', wanted]));
		return asked.machine.includes(wanted) ? asked : first;
	}

	/** Where a first storage pool goes: libvirt's usual folder for the system, the user's own for a local session. */
	private newPoolPath(): string | undefined {
		if (/\/system(\?|$)/.test(this.uri)) return '/var/lib/libvirt/images';
		return this.local ? join(homedir(), '.local', 'share', 'libvirt', 'images') : undefined;
	}

	/** The directory pool to create volumes in; on this computer one is made when there is none. */
	private async ensurePool(requested: string): Promise<string> {
		const pools = await this.names(['pool-list', '--type', 'dir', '--name']);
		if (requested) {
			if (!pools.includes(requested)) throw new ProviderError(`The storage pool "${requested}" is not active.`, 'invalid');
			return requested;
		}
		if (pools.length) return pools.includes('default') ? 'default' : pools[0]!;
		const path = this.newPoolPath();
		if (!path) throw new ProviderError('This libvirt has no directory storage pool. Create one on the host (virsh pool-define-as) first.', 'unavailable');
		const known = await this.names(['pool-list', '--all', '--name']);
		const name = known.includes('default') ? 'vmm' : 'default';
		if (!known.includes(name)) {
			await this.virsh.exec(['pool-define-as', name, 'dir', '--target', path]);
			await this.virsh.exec(['pool-build', name]);
			await this.virsh.exec(['pool-autostart', name]);
		}
		await this.virsh.exec(['pool-start', name]);
		return name;
	}

	/** What every new domain needs, checked before anything is created. */
	private async newDomainBasics(values: FieldValues) {
		const name = String(values.name ?? '').trim();
		if (!NAME.test(name)) throw new ProviderError('Use 1–64 letters, digits, "." "_" or "-" for the name, starting with a letter or digit.', 'invalid');
		const cpus = Number(values.cpus), memoryMB = Number(values.memoryMB), diskGB = Number(values.diskGB);
		if (!Number.isInteger(cpus) || cpus < 1) throw new ProviderError('Give at least one processor.', 'invalid');
		if (!Number.isFinite(memoryMB) || memoryMB < 128) throw new ProviderError('Give at least 128 MB of memory.', 'invalid');
		if (!Number.isFinite(diskGB) || diskGB < 1) throw new ProviderError('Give a disk of at least 1 GB.', 'invalid');
		const diskBus = DISK_BUSES.find((b) => b === values.diskBus) ?? 'virtio';
		const network = String(values.network ?? 'user');
		return { name, cpus, memoryMB, diskGB, diskBus, network };
	}

	/** The checks that ask libvirt; after the ones that do not, so a typo costs no round trip. */
	private async checkNewDomain(name: string, network: string): Promise<void> {
		if (network !== 'user' && !(await this.names(['net-list', '--name'])).includes(network)) throw new ProviderError(`The network "${network}" is not active.`, 'invalid');
		if ((await this.names(['list', '--all', '--name'])).includes(name)) throw new ProviderError(`A domain named "${name}" already exists.`, 'invalid');
	}

	async createVm(_nodeId: string, values: FieldValues, progress?: (update: CreateProgress) => void): Promise<VmInfo> {
		const basics = this.newDomainBasics(values);
		if (values.source === 'cloud') return this.createFromCloudImage(await basics, values, progress);
		const { name, cpus, memoryMB, diskGB, diskBus, network } = await basics;
		const iso = String(values.iso ?? '').trim();
		if (iso && !/^(\/|[A-Za-z]:[\\/])/.test(iso)) throw new ProviderError('Give the installation image as an absolute path on the libvirt host.', 'invalid');
		await this.checkNewDomain(name, network);

		progress?.({ message: 'Reading what the host supports…' });
		const host = await this.hostCapabilities();
		progress?.({ message: 'Creating the disk…' });
		const pool = await this.ensurePool(String(values.pool ?? ''));
		const volume = `${name}.qcow2`;
		await this.virsh.exec(['vol-create-as', pool, volume, `${diskGB}G`, '--format', 'qcow2'], 120_000);
		try {
			const diskPath = (await this.virsh.exec(['vol-path', '--pool', pool, volume])).trim();
			const xml = buildDomainXml({ name, cpus, memoryMB, diskPath, diskBus, iso: iso || undefined, uefi: values.firmware === 'uefi', network, host });
			progress?.({ message: 'Defining the domain…' });
			await this.define(xml);
		} catch (error) {
			await this.virsh.exec(['vol-delete', '--pool', pool, volume]).catch((e: Error) => this.log.warn(`Could not remove the new disk ${volume}: ${e.message}`));
			throw error;
		}
		return this.defined(name);
	}

	private async defined(name: string): Promise<VmInfo> {
		this.domains.clear();
		const vm = (await this.listVms(NODE_ID)).find((v) => v.name === name);
		if (!vm) throw new ProviderError('The domain was defined but libvirt does not list it.', 'failed');
		return vm;
	}

	/** Defines a domain from XML; virsh reads the file on this computer, whichever host the domain lives on. */
	private async define(xml: string): Promise<void> {
		const dir = await mkdtemp(join(tmpdir(), 'vmm-libvirt-'));
		try {
			const file = join(dir, 'domain.xml');
			await writeFile(file, xml, { mode: 0o600 });
			await this.virsh.exec(['define', file]);
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** A new volume in `pool` holding the bytes of a file on this computer (`vol-upload` streams it through libvirt). */
	private async uploadVolume(pool: string, volume: string, file: string, size: number, created: string[]): Promise<void> {
		await this.virsh.exec(['vol-create-as', pool, volume, `${size}b`, '--format', 'raw'], 120_000);
		created.push(volume);
		await this.virsh.exec(['vol-upload', '--pool', pool, volume, file], 3 * 3600_000);
	}

	/**
	 * A domain from a cloud image: the image is downloaded on this computer (checksum verified, cached) or
	 * taken from a file, uploaded into the pool as the domain's own disk and enlarged; a cloud-init `cidata`
	 * volume with the user, key and host name becomes its CD drive. The first boot sets everything up.
	 */
	private async createFromCloudImage(basics: Awaited<ReturnType<LibvirtConnection['newDomainBasics']>>, values: FieldValues, progress?: (update: CreateProgress) => void): Promise<VmInfo> {
		const { name, cpus, memoryMB, diskGB, diskBus, network } = basics;
		const choice = String(values.cloudImage ?? '');
		const image = choice === 'custom' ? undefined : findImage(choice);
		if (choice !== 'custom' && !image) throw new ProviderError('Choose a cloud image.', 'invalid');
		const user = String(values.ciUser ?? '').trim();
		const hostname = String(values.ciHostname ?? '').trim() || hostnameFor(name);
		const sshKeys = parseKeys(values.ciSshKey as string | undefined);
		const password = String(values.ciPassword ?? '');
		const customUserData = String(values.ciUserData ?? '');
		const passwordHash = password ? sha512Crypt(password) : undefined;
		if (!customUserData.trim()) {
			const problem = cloudInitProblem({ hostname, user, sshKeys, passwordHash });
			if (problem) throw new ProviderError(problem, 'invalid');
		}
		const customFile = String(values.cloudImageFile ?? '').trim();
		if (!image) {
			if (!customFile) throw new ProviderError('Enter the path of the disk image.', 'invalid');
			if (!existsSync(customFile)) throw new ProviderError(`Image not found on this computer: ${customFile}`, 'invalid');
		}
		await this.checkNewDomain(name, network);

		progress?.({ message: 'Reading what the host supports…', fraction: 0.01 });
		const host = await this.hostCapabilities();
		if (image && image.arch !== host.arch) throw new ProviderError(`${image.label} is for ${image.arch} guests; this libvirt runs ${host.arch} guests.`, 'invalid');
		const pool = await this.ensurePool(String(values.pool ?? ''));
		const source = image ? await ensureImage(localImageHost, image, this.imageDirectory, { onProgress: downloadProgress(image.label, 0.02, 0.6, progress) }) : customFile;
		const format = await imageFormat(source);
		const volume = `${name}.${format === 'qcow2' ? 'qcow2' : 'img'}`;
		const seedVolume = `${name}-cidata.iso`;
		const created: string[] = [];
		let dir: string | undefined;
		try {
			progress?.({ message: this.local ? 'Copying the image into the storage pool…' : 'Uploading the image to the host…', fraction: 0.62 });
			await this.uploadVolume(pool, volume, source, (await statSize(source)), created);
			// libvirt reads the format of a file in a directory pool from its header on a refresh.
			await this.virsh.exec(['pool-refresh', pool], 120_000);
			const disk = parseVolumeXml(await this.virsh.exec(['vol-dumpxml', '--pool', pool, volume]));
			if (disk.format !== format) throw new ProviderError(`libvirt reads ${volume} as ${disk.format ?? 'an unknown format'}, not ${format}.`, 'failed');
			// Never shrink an image: the requested size only applies when it is larger.
			if (disk.capacity !== undefined && disk.capacity < diskGB * 1024 ** 3) {
				progress?.({ message: `Enlarging the disk to ${diskGB} GB…`, fraction: 0.9 });
				await this.virsh.exec(['vol-resize', '--pool', pool, volume, `${diskGB}G`], 120_000);
			}

			progress?.({ message: 'Writing the cloud-init disk…', fraction: 0.93 });
			const data = { hostname, user, sshKeys, passwordHash, installAgent: values.ciAgent !== false, customUserData, instanceId: `vmm-${randomUUID()}` };
			const iso = buildIso([{ name: 'user-data', data: Buffer.from(userData(data), 'utf8') }, { name: 'meta-data', data: Buffer.from(metaData(data), 'utf8') }], { volumeId: 'cidata' });
			dir = await mkdtemp(join(tmpdir(), 'vmm-libvirt-'));
			const seedFile = join(dir, 'cidata.iso');
			await writeFile(seedFile, iso, { mode: 0o600 });
			await this.uploadVolume(pool, seedVolume, seedFile, iso.length, created);

			const [diskPath, seedPath] = await Promise.all([volume, seedVolume].map(async (v) => (await this.virsh.exec(['vol-path', '--pool', pool, v])).trim()));
			progress?.({ message: 'Defining the domain…', fraction: 0.97 });
			await this.define(buildDomainXml({ name, cpus, memoryMB, diskPath: diskPath!, diskFormat: format, diskBus, seed: seedPath, uefi: values.firmware === 'uefi', network, host }));
		} catch (error) {
			for (const v of created) await this.virsh.exec(['vol-delete', '--pool', pool, v]).catch((e: Error) => this.log.warn(`Could not remove the new volume ${v}: ${e.message}`));
			throw error;
		} finally {
			if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
		this.log.info(`Created ${name} from ${image ? image.label : customFile} in pool ${pool}`);
		progress?.({ message: 'Done', fraction: 1 });
		return this.defined(name);
	}
	async getVmConfig(): Promise<VmConfig> { throw new ProviderError('Domains are edited with virsh edit, virt-manager or Cockpit.', 'unsupported'); }
	async updateVm(): Promise<void> { throw new ProviderError('Domains are edited with virsh edit, virt-manager or Cockpit.', 'unsupported'); }

	async power(_nodeId: string, vmId: string, action: PowerAction): Promise<void> {
		const id = assertId(vmId);
		switch (action) {
			case 'start': {
				await this.virsh.exec(['start', id], 120_000);
				if (this.local) {
					const forwards = await this.savedForwards(id);
					if (forwards.length) await this.applyForwards(id, forwards).catch((e: Error) => this.log.warn(`Could not add the port forwards: ${e.message}`));
				}
				break;
			}
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
			for (const disk of domain.disks.filter((d) => d.path && DISK_TARGET.test(d.target) && (d.device === 'disk' || isSeed(d.path)))) {
				const isVolume = await this.virsh.exec(['vol-info', '--', disk.path!], 10_000).then(() => true, () => false);
				if (isVolume) managed.push(disk.target);
				// A cloud-init seed outside a pool was not made here: it stays.
				else if (disk.device === 'disk') loose.push(disk.path!);
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
