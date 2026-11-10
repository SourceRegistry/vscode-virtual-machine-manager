import * as net from 'node:net';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
	ProviderError,
	type Capabilities,
	type ClusterConfig,
	type ClusterConnection,
	type ConsoleKind,
	type ConsoleStream,
	type DeleteOptions,
	type FieldSchema,
	type FieldValues,
	type HypervisorProvider,
	type Logger,
	type NodeInfo,
	type PassthroughInfo,
	type PassthroughPlan,
	type PowerAction,
	type Snapshot,
	type PreviewFrame,
	type ProviderContext,
	type RdpTarget,
	type VmConfig,
	type VmDetails,
	type VmInfo,
	type VmState,
	type VmStats
} from '@vmm/sdk';
import { PowerShellError, PowerShellSession } from './PowerShellSession';
import { createWindowsSecurityContext } from './sspi';
import * as scripts from './scripts';
import { parseDeviceId, planAttach, planDetach, toPassthroughInfo, type RawDdaInfo } from './dda';
import { isTemplate, visibleNotes, withTemplate } from './template';
import { toSnapshots, type RawSnapshot } from './snapshots';
import { toDetails, toStats, type RawDetails, type RawStats } from './inspect';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VM_NAME = /^[^\\/:*?"<>|]{1,100}$/;
const NODE_ID = 'local';

interface RawVm {
	Id: string;
	Name: string;
	State: string;
	Cpus: number;
	MemoryMB: number;
	StartupMB: number;
	Uptime: number;
	Generation: number;
	Notes: string;
	Ips: string[] | string | null;
	ComPort: string;
	HasMedia?: boolean;
}

interface RawHost {
	Name: string;
	Cpus: number;
	MemoryMB: number;
	FreeMB: number;
	OsVersion?: string;
	/** Average load of all processors, percent. */
	CpuLoad?: number | null;
	Os: string;
	VhdPath: string;
}

interface RawConfig {
	Name: string;
	State: string;
	Generation: number;
	Cpus: number;
	MemoryMB: number;
	DynamicMemory: boolean;
	Switch: string;
	Iso: string;
	SecureBoot: string | null;
	AutoStart: string;
	AutoStop: string;
	CheckpointType: string;
	Serial: boolean;
	ComPort: string;
	Notes: string;
	Disks: string;
	Path: string;
}

export function mapState(state: string): VmState {
	switch (state) {
		case 'Running':
		case 'RunningCritical':
			return 'running';
		case 'Off':
		case 'OffCritical':
			return 'stopped';
		case 'Paused':
		case 'PausedCritical':
			return 'paused';
		case 'Saved':
		case 'SavedCritical':
			return 'saved';
		case 'Starting':
		case 'StartingCritical':
		case 'Resuming':
		case 'Reset':
		case 'ResetCritical':
			return 'starting';
		case 'Stopping':
		case 'StoppingCritical':
		case 'Saving':
		case 'SavingCritical':
		case 'Pausing':
		case 'PausingCritical':
			return 'stopping';
		default:
			return 'unknown';
	}
}

export function toVmInfo(raw: RawVm): VmInfo {
	const ips = (Array.isArray(raw.Ips) ? raw.Ips : raw.Ips ? [raw.Ips] : [])
		.filter(Boolean)
		// IPv4 first, skip link-local IPv6
		.filter((ip) => !ip.toLowerCase().startsWith('fe80'))
		.sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')));
	const state = mapState(raw.State);
	return {
		id: raw.Id,
		name: raw.Name,
		state,
		cpus: raw.Cpus,
		memoryMB: state === 'running' ? raw.MemoryMB : raw.StartupMB,
		uptimeSeconds: raw.Uptime || undefined,
		ipAddresses: ips,
		description: visibleNotes(raw.Notes) || undefined,
		...(isTemplate(raw.Notes) ? { template: true } : {}),
		os: `Generation ${raw.Generation}`,
		// Every VM has the VMConnect (RDP) console; the serial pipe only when a COM port is configured.
		consoles: raw.ComPort ? ['rdp', 'serial'] : ['rdp'],
		mediaInserted: raw.HasMedia
	};
}

function friendlyError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (/is not recognized as the name of a cmdlet|Get-VM/i.test(message) && /not recognized/i.test(message)) {
		return new ProviderError('The Hyper-V PowerShell module is not available. Enable Hyper-V (including its management tools) first.', 'unavailable');
	}
	if (/permission|access.*denied|required permission|authorization policy/i.test(message)) {
		return new ProviderError(
			'Access denied. Add your account to the "Hyper-V Administrators" group (sign out and in afterwards) or run VS Code as administrator.',
			'permission'
		);
	}
	if (error instanceof PowerShellError) return new ProviderError(message, 'failed');
	return error instanceof Error ? error : new Error(message);
}

function assertVmId(vmId: string): string {
	if (!GUID.test(vmId)) throw new ProviderError('Invalid virtual machine id', 'invalid');
	return vmId;
}

export class HyperVProvider implements HypervisorProvider {
	readonly id = 'hyperv';
	readonly displayName = 'Hyper-V';
	readonly icon = 'server-environment';
	readonly connectionSchema: FieldSchema[] = [
		{
			key: 'consoleMode',
			label: 'Graphical console',
			type: 'select',
			default: 'basic',
			options: [
				{ value: 'basic', label: 'Basic session (any guest, firmware and boot screens)' },
				{ value: 'enhanced', label: 'Enhanced session (needs guest support, e.g. Windows or xrdp)' }
			],
			description: 'Which VMConnect session the in-editor console opens.',
			advanced: true
		},
		{
			key: 'consoleSignIn',
			label: 'Console sign-in',
			type: 'select',
			default: 'windows',
			options: [
				{ value: 'windows', label: 'Current Windows account (single sign-on, like vmconnect)' },
				{ value: 'password', label: 'Ask for a user name and password' }
			],
			description: 'How the in-editor console authenticates to Hyper-V.',
			advanced: true
		}
	];

	defaultClusterName(): string {
		return 'Local (Hyper-V)';
	}

	async testConnection(_cluster: ClusterConfig, _secrets: unknown, context: ProviderContext): Promise<void> {
		const connection = await this.connect(_cluster, {}, context);
		try {
			await connection.listNodes();
		} finally {
			connection.dispose();
		}
	}

	async connect(cluster: ClusterConfig, _secrets: unknown, context: ProviderContext): Promise<HyperVConnection> {
		if (process.platform !== 'win32') {
			throw new ProviderError('Hyper-V is only available on Windows hosts.', 'unsupported');
		}
		const consoleMode = cluster.config.consoleMode === 'enhanced' ? 'enhanced' : 'basic';
		const singleSignOn = cluster.config.consoleSignIn !== 'password';
		return new HyperVConnection(context.log, consoleMode, singleSignOn);
	}
}

/** Port of the Hyper-V VM connection service (VMConnect speaks RDP with a pre-connection blob). */
export const VMCONNECT_PORT = 2179;

export class HyperVConnection implements ClusterConnection {
	readonly capabilities: Capabilities = {
		create: true,
		edit: true,
		delete: true,
		power: ['start', 'shutdown', 'reboot', 'stop'],
		consoles: ['rdp', 'serial'],
		preview: true,
		external: true,
		media: true,
		details: true,
		passthrough: true,
		stats: true,
		snapshots: true,
		clone: true,
		templates: true
	};

	/** Fast queries (polling). */
	private readonly query: PowerShellSession;
	/** Slow operations (graceful shutdown can take minutes) so they never block polling. */
	private readonly ops: PowerShellSession;
	private preview: PowerShellSession | undefined;
	private hostCache: RawHost | undefined;

	/** Windows single sign-on (SSPI) for the RDP console; started on first use. */
	private sspi: PowerShellSession | undefined;

	constructor(
		private readonly log: Logger,
		private readonly consoleMode: 'basic' | 'enhanced' = 'basic',
		private readonly singleSignOn = true
	) {
		this.query = new PowerShellSession('query', log);
		this.ops = new PowerShellSession('ops', log);
	}

	private async run<T>(session: PowerShellSession, script: string, params?: unknown, timeout?: number): Promise<T[]> {
		try {
			return await session.run<T>(script, params, timeout);
		} catch (error) {
			throw friendlyError(error);
		}
	}

	async listNodes(): Promise<NodeInfo[]> {
		const [host] = await this.run<RawHost>(this.query, scripts.HOST_INFO);
		this.hostCache = host;
		return [
			{
				id: NODE_ID,
				name: host?.Name ?? os.hostname(),
				status: 'online',
				cpus: host?.Cpus,
				memoryMB: host?.MemoryMB,
				memoryUsedMB: host ? host.MemoryMB - host.FreeMB : undefined,
				description: host?.Os,
				cpuUsage: typeof host?.CpuLoad === 'number' ? Math.min(1, Math.max(0, host.CpuLoad / 100)) : undefined,
				facts: host
					? [
							{ label: 'Hyper-V host', value: [host.Os, host.OsVersion].filter(Boolean).join(' ') },
							{ label: 'VM storage', value: host.VhdPath ?? '–' }
						]
					: undefined
			}
		];
	}

	async listVms(): Promise<VmInfo[]> {
		const vms = await this.run<RawVm>(this.query, scripts.LIST_VMS);
		return vms.map(toVmInfo);
	}

	private async switches(): Promise<{ value: string; label: string; description?: string }[]> {
		const switches = await this.run<{ Name: string; Type: string }>(this.query, scripts.LIST_SWITCHES);
		return switches.map((s) => ({ value: s.Name, label: s.Name, description: s.Type }));
	}

	async getCreateSchema(): Promise<FieldSchema[]> {
		const switches = await this.switches();
		const defaultSwitch = switches.find((s) => s.value === 'Default Switch')?.value ?? switches[0]?.value;
		return [
			{ key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'my-vm' },
			{ key: 'cpus', label: 'Processors', type: 'number', unit: 'cores', min: 1, max: 240, default: 2, required: true },
			{ key: 'memoryMB', label: 'Startup memory', type: 'number', unit: 'MB', min: 32, default: 4096, required: true },
			{ key: 'diskGB', label: 'Disk size', type: 'number', unit: 'GB', min: 1, max: 65536, default: 64, required: true },
			{
				key: 'generation',
				label: 'Generation',
				type: 'select',
				required: true,
				default: '2',
				options: [
					{ value: '2', label: 'Generation 2', description: 'UEFI, Secure Boot — modern operating systems' },
					{ value: '1', label: 'Generation 1', description: 'BIOS — legacy operating systems' }
				]
			},
			{
				key: 'secureBoot',
				label: 'Secure Boot',
				type: 'select',
				default: 'MicrosoftWindows',
				description: 'Generation 2 only',
				required: true,
				options: [
					{ value: 'MicrosoftWindows', label: 'Microsoft Windows' },
					{ value: 'MicrosoftUEFICertificateAuthority', label: 'Microsoft UEFI CA', description: 'Most Linux distributions' },
					{ value: 'off', label: 'Disabled' }
				]
			},
			{ key: 'switch', label: 'Network switch', type: 'select', options: switches, default: defaultSwitch },
			{ key: 'iso', label: 'Installation media (ISO)', type: 'file', filters: { 'Disk images': ['iso'] } },
			{ key: 'dynamicMemory', label: 'Dynamic memory', type: 'checkbox', default: true, advanced: true },
			{ key: 'serial', label: 'Serial console (COM1 named pipe)', type: 'checkbox', default: true, advanced: true },
			{
				key: 'vhdDirectory',
				label: 'Disk location',
				type: 'directory',
				placeholder: this.hostCache?.VhdPath || 'Hyper-V default',
				advanced: true
			},
			{ key: 'notes', label: 'Notes', type: 'textarea', advanced: true }
		];
	}

	async createVm(_nodeId: string, values: FieldValues): Promise<VmInfo> {
		const name = String(values.name ?? '').trim();
		if (!VM_NAME.test(name)) throw new ProviderError('The name contains characters that are not allowed: \\ / : * ? " < > |', 'invalid');
		const params = {
			name,
			cpus: Number(values.cpus ?? 2),
			memoryMB: Number(values.memoryMB ?? 4096),
			diskGB: Number(values.diskGB ?? 64),
			generation: Number(values.generation ?? 2),
			secureBoot: values.secureBoot ?? 'MicrosoftWindows',
			switch: values.switch,
			iso: values.iso,
			dynamicMemory: values.dynamicMemory ?? true,
			serial: values.serial ?? true,
			vhdDirectory: values.vhdDirectory,
			notes: values.notes
		};
		const [created] = await this.run<{ Id: string; Name: string }>(this.ops, scripts.CREATE_VM, params, 5 * 60_000);
		if (!created) throw new ProviderError('Hyper-V did not return the new virtual machine');
		return { id: created.Id, name: created.Name, state: 'stopped' };
	}

	async getVmConfig(_nodeId: string, vmId: string): Promise<VmConfig> {
		const [config] = await this.run<RawConfig>(this.query, scripts.GET_CONFIG, { id: assertVmId(vmId) });
		if (!config) throw new ProviderError('Virtual machine not found', 'notFound');
		const switches = await this.switches();
		const off = config.State === 'Off';
		const offOnly = off ? undefined : 'Can only be changed while the virtual machine is off.';
		const schema: FieldSchema[] = [
			{ key: 'name', label: 'Name', type: 'text', required: true, group: 'General' },
			{ key: 'notes', label: 'Notes', type: 'textarea', group: 'General' },
			{ key: 'generation', label: 'Generation', type: 'number', readonly: true, group: 'General' },
			{ key: 'path', label: 'Configuration location', type: 'text', readonly: true, group: 'General' },
			{ key: 'cpus', label: 'Processors', type: 'number', unit: 'cores', min: 1, max: 240, required: true, group: 'Hardware', description: offOnly },
			{ key: 'memoryMB', label: 'Startup memory', type: 'number', unit: 'MB', min: 32, required: true, group: 'Hardware' },
			{ key: 'dynamicMemory', label: 'Dynamic memory', type: 'checkbox', group: 'Hardware', description: offOnly },
			{ key: 'disks', label: 'Hard disks', type: 'text', readonly: true, group: 'Hardware' },
			{ key: 'iso', label: 'DVD drive (ISO)', type: 'file', filters: { 'Disk images': ['iso'] }, group: 'Hardware' },
			{ key: 'switch', label: 'Network switch', type: 'select', options: switches, group: 'Network' },
			{
				key: 'serial',
				label: 'Serial console (COM1 named pipe)',
				type: 'checkbox',
				group: 'Console',
				description: config.ComPort ? `Connected to ${config.ComPort}` : offOnly
			}
		];
		if (config.Generation === 2) {
			schema.push({
				key: 'secureBoot',
				label: 'Secure Boot',
				type: 'select',
				group: 'Firmware',
				required: true,
				description: offOnly,
				options: [
					{ value: 'MicrosoftWindows', label: 'Microsoft Windows' },
					{ value: 'MicrosoftUEFICertificateAuthority', label: 'Microsoft UEFI CA' },
					{ value: 'off', label: 'Disabled' }
				]
			});
		}
		schema.push(
			{
				key: 'autoStart',
				label: 'Automatic start action',
				type: 'select',
				group: 'Automation',
				required: true,
				options: [
					{ value: 'Nothing', label: 'Nothing' },
					{ value: 'StartIfRunning', label: 'Start if it was running' },
					{ value: 'Start', label: 'Always start' }
				]
			},
			{
				key: 'autoStop',
				label: 'Automatic stop action',
				type: 'select',
				group: 'Automation',
				required: true,
				options: [
					{ value: 'Save', label: 'Save state' },
					{ value: 'TurnOff', label: 'Turn off' },
					{ value: 'ShutDown', label: 'Shut down the guest' }
				]
			},
			{
				key: 'checkpointType',
				label: 'Checkpoint type',
				type: 'select',
				group: 'Automation',
				required: true,
				options: [
					{ value: 'Production', label: 'Production' },
					{ value: 'ProductionOnly', label: 'Production only' },
					{ value: 'Standard', label: 'Standard' },
					{ value: 'Disabled', label: 'Disabled' }
				]
			}
		);
		return {
			schema,
			values: {
				name: config.Name,
				notes: visibleNotes(config.Notes) || undefined,
				generation: config.Generation,
				path: config.Path,
				cpus: config.Cpus,
				memoryMB: config.MemoryMB,
				dynamicMemory: config.DynamicMemory,
				disks: config.Disks,
				iso: config.Iso || undefined,
				switch: config.Switch || undefined,
				serial: config.Serial,
				secureBoot: config.SecureBoot ?? undefined,
				autoStart: config.AutoStart,
				autoStop: config.AutoStop,
				checkpointType: config.CheckpointType
			}
		};
	}

	async updateVm(_nodeId: string, vmId: string, values: FieldValues): Promise<void> {
		if (values.name !== undefined && !VM_NAME.test(String(values.name).trim())) {
			throw new ProviderError('The name contains characters that are not allowed: \\ / : * ? " < > |', 'invalid');
		}
		const id = assertVmId(vmId);
		if (values.notes !== undefined) {
			// A template keeps its marker when the user edits the notes.
			const [current] = await this.run<RawConfig>(this.query, scripts.GET_CONFIG, { id });
			if (isTemplate(current?.Notes)) values = { ...values, notes: withTemplate(String(values.notes ?? ''), true) };
		}
		await this.run(this.ops, scripts.UPDATE_VM, { id, values }, 2 * 60_000);
	}

	async listSnapshots(_nodeId: string, vmId: string): Promise<Snapshot[]> {
		return toSnapshots(await this.run<RawSnapshot>(this.query, scripts.SNAPSHOT_LIST, { id: assertVmId(vmId) }, 60_000));
	}

	async createSnapshot(_nodeId: string, vmId: string, name: string): Promise<Snapshot> {
		const trimmed = name.trim();
		if (!trimmed || trimmed.length > 100) throw new ProviderError('A snapshot name has 1 to 100 characters.', 'invalid');
		const [created] = await this.run<RawSnapshot>(this.ops, scripts.SNAPSHOT_CREATE, { id: assertVmId(vmId), name: trimmed }, 10 * 60_000);
		if (!created) throw new ProviderError('Hyper-V did not return the new snapshot');
		return toSnapshots([created])[0];
	}

	async revertSnapshot(_nodeId: string, vmId: string, snapshotId: string): Promise<void> {
		await this.run(this.ops, scripts.SNAPSHOT_RESTORE, { id: assertVmId(vmId), snapshot: assertVmId(snapshotId) }, 10 * 60_000);
	}

	async deleteSnapshot(_nodeId: string, vmId: string, snapshotId: string): Promise<void> {
		await this.run(this.ops, scripts.SNAPSHOT_DELETE, { id: assertVmId(vmId), snapshot: assertVmId(snapshotId) }, 10 * 60_000);
	}

	async cloneVm(_nodeId: string, vmId: string, name: string): Promise<VmInfo> {
		const trimmed = name.trim();
		if (!VM_NAME.test(trimmed)) throw new ProviderError('The name contains characters that are not allowed: \\ / : * ? " < > |', 'invalid');
		const [copy] = await this.run<{ Id: string; Name: string }>(this.ops, scripts.CLONE_VM, { id: assertVmId(vmId), name: trimmed }, 60 * 60_000);
		if (!copy) throw new ProviderError('Hyper-V did not return the new virtual machine');
		return (await this.listVms()).find((v) => v.id === copy.Id) ?? { id: copy.Id, name: copy.Name, state: 'stopped' };
	}

	async setTemplate(_nodeId: string, vmId: string, template: boolean): Promise<void> {
		const id = assertVmId(vmId);
		const [current] = await this.run<RawConfig>(this.query, scripts.GET_CONFIG, { id });
		if (isTemplate(current?.Notes) === template) return;
		await this.run(this.ops, scripts.SET_NOTES_TEMPLATE, { id, notes: withTemplate(current?.Notes, template) }, 60_000);
	}

	async deleteVm(_nodeId: string, vmId: string, options: DeleteOptions): Promise<void> {
		await this.run(this.ops, scripts.DELETE_VM, { id: assertVmId(vmId), deleteDisks: options.deleteDisks }, 5 * 60_000);
	}

	async power(_nodeId: string, vmId: string, action: PowerAction): Promise<void> {
		// Graceful shutdown waits for the guest; give it time.
		const timeout = action === 'shutdown' || action === 'reboot' ? 10 * 60_000 : 2 * 60_000;
		// Calls on one session run in order: while it is busy (e.g. a shutdown waiting for the
		// guest) use a separate PowerShell process so this operation is not queued behind it.
		if (!this.ops.busy) {
			await this.run(this.ops, scripts.POWER, { id: assertVmId(vmId), action }, timeout);
			return;
		}
		const session = new PowerShellSession(`ops-${action}`, this.log);
		try {
			await this.run(session, scripts.POWER, { id: assertVmId(vmId), action }, timeout);
		} finally {
			session.dispose();
		}
	}

	async getVmDetails(_nodeId: string, vmId: string): Promise<VmDetails> {
		const [raw] = await this.run<RawDetails>(this.query, scripts.VM_DETAILS, { id: assertVmId(vmId) }, 60_000);
		return toDetails(raw ?? { Generation: 0, Disks: null, Nics: null });
	}

	async getVmStats(_nodeId: string, vmId: string): Promise<VmStats> {
		const [raw] = await this.run<RawStats>(this.query, scripts.VM_STATS, { id: assertVmId(vmId) });
		return toStats(raw ?? { CpuPercent: null, AssignedMB: null, DemandMB: null, StartupMB: null });
	}

	async ejectMedia(_nodeId: string, vmId: string, deviceId: string): Promise<void> {
		await this.run(this.ops, scripts.SET_MEDIA, { id: assertVmId(vmId), device: deviceId, path: '' }, 60_000);
	}

	async insertMedia(_nodeId: string, vmId: string, deviceId: string, imagePath: string): Promise<void> {
		await this.run(this.ops, scripts.SET_MEDIA, { id: assertVmId(vmId), device: deviceId, path: imagePath }, 60_000);
	}

	async getPassthrough(_nodeId: string, vmId: string): Promise<PassthroughInfo> {
		const [raw] = await this.run<RawDdaInfo>(this.query, scripts.DDA_LIST, { id: assertVmId(vmId) }, 90_000);
		return toPassthroughInfo(raw ?? { IsServer: false, HasCmdlets: false, Devices: null });
	}

	async planPassthrough(_nodeId: string, vmId: string, deviceId: string, action: 'attach' | 'detach'): Promise<PassthroughPlan> {
		const path = parseDeviceId(deviceId);
		const name = await this.vmName(vmId);
		return action === 'attach' ? planAttach(name, path) : planDetach(name, path);
	}

	async changePassthrough(nodeId: string, vmId: string, deviceId: string, action: 'attach' | 'detach', options: { confirmed: boolean }): Promise<void> {
		const plan = await this.planPassthrough(nodeId, vmId, deviceId, action);
		if (plan.needsConfirmation && !options.confirmed) throw new ProviderError('This change needs the explicit confirmation of the user.', 'permission');
		const info = await this.getPassthrough(nodeId, vmId);
		if (!info.pci.supported) throw new ProviderError(info.pci.reason ?? 'Device assignment is not available on this host', 'unsupported');
		await this.run(this.ops, action === 'attach' ? scripts.DDA_ATTACH : scripts.DDA_DETACH, { id: assertVmId(vmId), path: parseDeviceId(deviceId) }, 180_000);
	}

	private async vmName(vmId: string): Promise<string> {
		const [raw] = await this.run<{ Name: string }>(this.query, scripts.VM_NAME, { id: assertVmId(vmId) });
		return raw?.Name ?? vmId;
	}

	async getRdpTarget(_nodeId: string, vmId: string): Promise<RdpTarget> {
		assertVmId(vmId);
		const host = os.hostname();
		const [account] = await this.run<{ User: string; Domain: string; MicrosoftAccount: string; Passwordless: boolean }>(
			this.query,
			scripts.CONSOLE_ACCOUNT
		).catch(() => []);
		const user = account?.User || process.env.USERNAME;
		const msa = account?.MicrosoftAccount || undefined;
		const help = [
			msa
				? `This Windows account is a Microsoft account: sign in as MicrosoftAccount\\${msa} with the Microsoft account password (a Windows Hello PIN does not work).`
				: `Sign in with a Windows account on ${host} that may manage Hyper-V (member of "Hyper-V Administrators"), as ${host}\\name.`,
			account?.Passwordless
				? 'This PC only allows Windows Hello sign-in for Microsoft accounts, which rejects passwords: turn off "For improved security, only allow Windows Hello sign-in for Microsoft accounts on this device" (Settings › Accounts › Sign-in options), or use a local account in "Hyper-V Administrators".'
				: '',
			msa ? 'If the password is right and it still fails, sign in to Windows once with the password (not the PIN) so Windows can verify it.' : ''
		]
			.filter(Boolean)
			.join(' ');
		return {
			serverName: host,
			vmConnect: { vmId, mode: this.consoleMode },
			defaultUsername: msa ? `MicrosoftAccount\\${msa}` : user ? `${account?.Domain || process.env.USERDOMAIN || host}\\${user}` : undefined,
			credentialsHint: msa ? `your Microsoft account on ${host}` : `your Windows account on ${host}`,
			signInHelp: help,
			currentUser: this.singleSignOn
				? {
						displayName: `${account?.Domain || process.env.USERDOMAIN || host}\\${user ?? ''}`,
						createContext: (targetName) => createWindowsSecurityContext((this.sspi ??= new PowerShellSession('sspi', this.log)), targetName, this.log)
					}
				: undefined
		};
	}

	async openConsole(_nodeId: string, vmId: string, kind: ConsoleKind): Promise<ConsoleStream> {
		if (kind === 'vnc') throw new ProviderError('Hyper-V has no VNC endpoint; use the RDP console.', 'unsupported');
		assertVmId(vmId);
		const raw = (await this.run<RawVm>(this.query, scripts.LIST_VMS)).find((v) => v.Id === vmId);
		if (!raw) throw new ProviderError('Virtual machine not found', 'notFound');
		const vm = toVmInfo(raw);
		if (kind === 'rdp') return this.openVmConnect(vm);
		const pipe = raw.ComPort;
		if (!pipe) {
			throw new ProviderError(
				'No serial port is configured. Enable "Serial console" in the VM settings while the machine is off.',
				'unavailable'
			);
		}
		if (vm.state !== 'running') throw new ProviderError(`${vm.name} is not running`, 'unavailable');
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.connect(pipe);
			s.once('connect', () => resolve(s));
			s.once('error', (error: NodeJS.ErrnoException) => {
				if (error.code === 'EACCES' || error.code === 'EPERM') {
					reject(new ProviderError('Access to the serial pipe was denied. Hyper-V only allows administrators to open it: run VS Code as administrator.', 'permission'));
				} else if (error.code === 'EBUSY') {
					reject(new ProviderError('The serial port is in use by another program.', 'unavailable'));
				} else reject(error);
			});
		});
		this.log.info(`Serial console connected to ${pipe}`);
		return { stream: socket, dispose: () => socket.destroy() };
	}

	/** Raw TCP to the local VM connection service; the core adds the pre-connection blob and TLS. */
	private async openVmConnect(vm: VmInfo): Promise<ConsoleStream> {
		if (vm.state !== 'running' && vm.state !== 'paused') throw new ProviderError(`${vm.name} is not running`, 'unavailable');
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.connect({ host: '127.0.0.1', port: VMCONNECT_PORT });
			s.once('connect', () => resolve(s));
			s.once('error', (error: NodeJS.ErrnoException) => {
				reject(
					error.code === 'ECONNREFUSED'
						? new ProviderError('The Hyper-V VM connection service (port 2179) is not reachable. Is the Hyper-V Virtual Machine Management service running?', 'unavailable')
						: error
				);
			});
		});
		socket.setNoDelay(true);
		this.log.info(`VMConnect console connecting to ${vm.name}`);
		return { stream: socket, dispose: () => socket.destroy() };
	}

	async *openPreview(_nodeId: string, vmId: string, signal: AbortSignal): AsyncIterable<PreviewFrame> {
		assertVmId(vmId);
		this.preview ??= new PowerShellSession('preview', this.log);
		while (!signal.aborted) {
			const started = Date.now();
			const [frame] = await this.run<{ Width: number; Height: number; Data: string }>(
				this.preview,
				scripts.THUMBNAIL,
				{ id: vmId, maxWidth: 1280 },
				20_000
			);
			if (signal.aborted) return;
			if (frame) {
				yield {
					width: frame.Width,
					height: frame.Height,
					format: 'rgb565',
					data: new Uint8Array(Buffer.from(frame.Data, 'base64'))
				};
			}
			const wait = Math.max(150, 700 - (Date.now() - started));
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}

	async openExternal(_nodeId: string, vmId: string): Promise<void> {
		const vm = (await this.listVms()).find((v) => v.id === assertVmId(vmId));
		if (!vm) throw new ProviderError('Virtual machine not found', 'notFound');
		const child = spawn('vmconnect.exe', ['localhost', vm.name], { detached: true, stdio: 'ignore', windowsHide: false });
		child.on('error', (error) => this.log.error(`vmconnect failed: ${error.message}`));
		child.unref();
	}

	dispose(): void {
		this.query.dispose();
		this.ops.dispose();
		this.preview?.dispose();
		this.sspi?.dispose();
	}
}
