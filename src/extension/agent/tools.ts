/**
 * The machines as tools for AI agents. One definition per tool serves both surfaces: the language model tools
 * of VS Code's agent mode (`vscode.lm.registerTool`, declared in package.json `languageModelTools`) and the
 * MCP server for agents outside VS Code (`mcpServer.ts`). No `vscode` import here, so it is unit tested as is.
 *
 * Every call has a risk: `read` runs without asking, `action` (start, snapshot, a command in the guest…) is
 * confirmed by the user first, `control` (keyboard and mouse) is allowed once per machine for a while, and
 * `destructive` (power off, reset, revert, delete) also needs `vmm.agent.allowDestructive`. Results never carry
 * cluster settings or secrets: only machine facts.
 */
import type { Capabilities, GuestCommand, GuestCommandResult, PortForward, PowerAction, Snapshot, VmDetails, VmState, VmStats } from '@vmm/sdk';
import type { MouseAction, Screenshot } from './display';
import { comboStrokes, textStrokes, type KeyStroke } from './keys';

export type Risk = 'read' | 'action' | 'control' | 'destructive';

/** A result with pictures: the JSON part as text for the model, the images beside it. */
export class ToolOutput {
	constructor(
		readonly json: unknown,
		readonly images: Array<{ mimeType: 'image/png'; data: Buffer }>
	) {}
}

/** A JSON schema for a tool's input: the subset the tools use, checked by `validateInput`. */
export interface InputSchema {
	type: 'object';
	properties: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean' | 'array'; description: string; enum?: string[]; items?: { type: 'string' }; minimum?: number; maximum?: number }>;
	required?: string[];
	additionalProperties?: false;
}

export interface AgentVm {
	/** Stable handle (`cluster/node/vm` ids), accepted wherever a tool takes `vm`. */
	id: string;
	name: string;
	cluster: string;
	node: string;
	state: VmState;
	ipAddresses: string[];
	cpus?: number;
	memoryMB?: number;
	os?: string;
	template?: boolean;
	kind?: 'vm' | 'container';
	favorite: boolean;
	groups: string[];
}

export interface AgentCluster {
	name: string;
	provider: string;
	status: string;
	nodes: Array<{ name: string; status: string; vms: number }>;
}

/** What the tools need from the extension. `vm` is a name, `cluster/name` or an id (see `vmLookup`). */
export interface AgentBackend {
	clusters(): Promise<AgentCluster[]>;
	list(): Promise<AgentVm[]>;
	get(vm: string): Promise<{ vm: AgentVm; capabilities: Capabilities }>;
	details(vm: string): Promise<VmDetails>;
	stats(vm: string): Promise<VmStats>;
	snapshots(vm: string): Promise<Snapshot[]>;
	address(vm: string, options: { ssh: boolean; timeoutMs: number }): Promise<{ host: string; port?: number } | undefined>;
	power(vm: string, action: PowerAction): Promise<void>;
	waitForState(vm: string, state: VmState, timeoutMs: number): Promise<AgentVm>;
	takeSnapshot(vm: string, name: string): Promise<Snapshot>;
	revertSnapshot(vm: string, snapshot: string): Promise<Snapshot>;
	deleteSnapshot(vm: string, snapshot: string): Promise<Snapshot>;
	runInGuest(vm: string, command: GuestCommand): Promise<GuestCommandResult>;
	copyToGuest(vm: string, localPath: string, guestPath: string): Promise<void>;
	copyFromGuest(vm: string, guestPath: string, localPath: string): Promise<void>;
	addPortForward(vm: string, forward: PortForward): Promise<void>;
	/** The screen now, or after `settleMs` (so what a key or click caused has been drawn). */
	screenshot(vm: string, options?: { settleMs?: number }): Promise<Screenshot>;
	sendKeys(vm: string, strokes: readonly KeyStroke[]): Promise<void>;
	mouse(vm: string, action: MouseAction): Promise<void>;
	/** Hands the keyboard and mouse back: the next key or click asks the user again. */
	releaseControl(vm: string): Promise<{ released: boolean }>;
}

export interface AgentTool<I = Record<string, unknown>> {
	/** `vmm_…`: the language model tool name and the MCP tool name. */
	name: string;
	/** Shown in VS Code's tool picker and as the MCP title. */
	title: string;
	/** For the model: what it does and when to use it. */
	description: string;
	inputSchema: InputSchema;
	risk(input: I): Risk;
	/** One line for the confirmation of an `action` or `destructive` call. */
	describe(input: I): string;
	/** A plain value is sent as JSON; a `ToolOutput` also carries images. */
	run(input: I, backend: AgentBackend): Promise<unknown>;
}

const vmParam = { type: 'string' as const, description: 'The machine: its name, "cluster/name" when names repeat across clusters, or its id from vmm_list_vms.' };
const POWER: PowerAction[] = ['start', 'shutdown', 'reboot', 'stop', 'reset'];
const STATES: VmState[] = ['running', 'stopped', 'paused', 'saved'];
const MAX_WAIT_SECONDS = 600;
/** Text a guest command returns is cut to this many characters per stream, to keep the agent's context small. */
export const MAX_OUTPUT_CHARS = 64 * 1024;

const clip = (text: string) => (text.length > MAX_OUTPUT_CHARS ? { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${text.length - MAX_OUTPUT_CHARS} more characters cut)`, cut: true } : { text, cut: false });

/** Which of the provider's features the agent can use on this machine. */
function abilities(caps: Capabilities, vm: AgentVm): string[] {
	if (vm.template) return [...(caps.clone ? ['clone'] : [])];
	return [
		...caps.power.map((p) => `power:${p}`),
		...(caps.details ? ['details'] : []),
		...(caps.stats ? ['stats'] : []),
		...(caps.snapshots ? ['snapshots'] : []),
		...(caps.guestExec ? ['run_in_guest'] : []),
		...(caps.guestFiles ? ['copy_files'] : []),
		...(caps.forwards ? ['port_forwards'] : []),
		...(caps.consoles.includes('vnc') ? ['screen'] : [])
	];
}

/** How long after a key or click a `screenshotAfter` waits, so the guest has drawn the result. */
const SETTLE_MS = 700;
const MAX_TEXT = 2000;

function screenshotOutput(shot: Screenshot, extra: Record<string, unknown> = {}): ToolOutput {
	return new ToolOutput(
		{ ...extra, screenshot: { width: shot.width, height: shot.height }, screen: shot.screen, note: 'Coordinates for vmm_mouse are pixels of this screenshot.' },
		[{ mimeType: 'image/png', data: shot.png }]
	);
}

const screenshotAfterParam = { type: 'boolean' as const, description: 'Return a screenshot taken just after, to see the result without another call.' };

export const TOOLS: AgentTool<any>[] = [
	{
		name: 'vmm_list_clusters',
		title: 'List hypervisor clusters',
		description: 'Lists the hypervisor clusters configured in VM Manager (local QEMU, libvirt, Hyper-V, Proxmox, Nutanix…), whether they are connected, and their nodes with the number of machines on each.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		risk: () => 'read',
		describe: () => 'List the clusters',
		run: async (_input, backend) => ({ clusters: await backend.clusters() })
	},
	{
		name: 'vmm_list_vms',
		title: 'List virtual machines',
		description: 'Lists the virtual machines and containers of every cluster with their state, IP addresses, vCPUs and memory. Filter by state, cluster or a text in the name. Use this first to find the machine to work on.',
		inputSchema: {
			type: 'object',
			properties: {
				state: { type: 'string', description: 'Only machines in this state.', enum: ['running', 'stopped', 'paused', 'saved', 'starting', 'stopping', 'unknown'] },
				cluster: { type: 'string', description: 'Only machines of the cluster with this name.' },
				name: { type: 'string', description: 'Only machines whose name contains this text (case-insensitive).' }
			},
			additionalProperties: false
		},
		risk: () => 'read',
		describe: () => 'List the virtual machines',
		run: async (input: { state?: string; cluster?: string; name?: string }, backend) => {
			const text = input.name?.toLowerCase();
			const vms = (await backend.list()).filter((vm) => (!input.state || vm.state === input.state) && (!input.cluster || vm.cluster === input.cluster) && (!text || vm.name.toLowerCase().includes(text)));
			return { count: vms.length, vms };
		}
	},
	{
		name: 'vmm_get_vm',
		title: 'Get virtual machine details',
		description: 'Describes one machine: state, addresses, its disks, network adapters (with MAC and IP addresses), port forwards and devices, and what can be done with it here (power actions, snapshots, commands in the guest, file copies).',
		inputSchema: { type: 'object', properties: { vm: vmParam }, required: ['vm'], additionalProperties: false },
		risk: () => 'read',
		describe: (input: { vm: string }) => `Read the details of ${input.vm}`,
		run: async (input: { vm: string }, backend) => {
			const { vm, capabilities } = await backend.get(input.vm);
			const details = capabilities.details && !vm.template ? await backend.details(input.vm).catch((error: Error) => ({ unavailable: error.message })) : undefined;
			return { vm, can: abilities(capabilities, vm), ...(details ? { details } : {}) };
		}
	},
	{
		name: 'vmm_get_vm_stats',
		title: 'Get virtual machine usage',
		description: 'One sample of a running machine\'s usage: CPU (0..1), memory used and total in MB, uptime, and cumulative disk and network byte counters (take two samples to compute a rate).',
		inputSchema: { type: 'object', properties: { vm: vmParam }, required: ['vm'], additionalProperties: false },
		risk: () => 'read',
		describe: (input: { vm: string }) => `Read the usage of ${input.vm}`,
		run: async (input: { vm: string }, backend) => ({ stats: await backend.stats(input.vm) })
	},
	{
		name: 'vmm_list_snapshots',
		title: 'List snapshots',
		description: 'Lists the snapshots of a machine, oldest first, with their id, name, time and whether they hold memory state.',
		inputSchema: { type: 'object', properties: { vm: vmParam }, required: ['vm'], additionalProperties: false },
		risk: () => 'read',
		describe: (input: { vm: string }) => `List the snapshots of ${input.vm}`,
		run: async (input: { vm: string }, backend) => ({ snapshots: await backend.snapshots(input.vm) })
	},
	{
		name: 'vmm_get_vm_address',
		title: 'Get virtual machine address',
		description: 'Where to reach a running machine: an IP address, or with ssh=true a host and port where an SSH server answers (a port forward for machines behind NAT). Can wait for the machine to come up.',
		inputSchema: {
			type: 'object',
			properties: {
				vm: vmParam,
				ssh: { type: 'boolean', description: 'Return an address where SSH answers (checked with a banner probe) instead of any IP address.' },
				waitSeconds: { type: 'integer', description: `Keep trying this long while there is no address yet (0 to ${MAX_WAIT_SECONDS}).`, minimum: 0, maximum: MAX_WAIT_SECONDS }
			},
			required: ['vm'],
			additionalProperties: false
		},
		risk: () => 'read',
		describe: (input: { vm: string }) => `Find the address of ${input.vm}`,
		run: async (input: { vm: string; ssh?: boolean; waitSeconds?: number }, backend) => {
			const address = await backend.address(input.vm, { ssh: !!input.ssh, timeoutMs: (input.waitSeconds ?? 0) * 1000 });
			return address ? { found: true, ...address } : { found: false, hint: 'No address yet: the machine may be stopped, still booting, or without a guest agent reporting its address.' };
		}
	},
	{
		name: 'vmm_power_vm',
		title: 'Start, shut down or restart a virtual machine',
		description: 'Changes a machine\'s power state. start, shutdown (asks the guest to shut down) and reboot are ordinary actions; stop (immediate power off) and reset (hard reset) lose unsaved guest data and are only allowed when the user enabled destructive actions. With wait=true it returns once the machine reached the new state.',
		inputSchema: {
			type: 'object',
			properties: {
				vm: vmParam,
				action: { type: 'string', description: 'What to do.', enum: POWER },
				wait: { type: 'boolean', description: 'Wait until the machine is running (start, reboot, reset) or stopped (shutdown, stop).' },
				waitSeconds: { type: 'integer', description: `How long to wait at most (default 120, at most ${MAX_WAIT_SECONDS}).`, minimum: 1, maximum: MAX_WAIT_SECONDS }
			},
			required: ['vm', 'action'],
			additionalProperties: false
		},
		risk: (input: { action: PowerAction }) => (input.action === 'stop' || input.action === 'reset' ? 'destructive' : 'action'),
		describe: (input: { vm: string; action: PowerAction }) => `${{ start: 'Start', shutdown: 'Shut down', reboot: 'Reboot', stop: 'Power off (no clean shutdown)', reset: 'Hard reset' }[input.action]} ${input.vm}`,
		run: async (input: { vm: string; action: PowerAction; wait?: boolean; waitSeconds?: number }, backend) => {
			await backend.power(input.vm, input.action);
			if (!input.wait) return { requested: input.action };
			const target: VmState = input.action === 'shutdown' || input.action === 'stop' ? 'stopped' : 'running';
			return { requested: input.action, vm: await backend.waitForState(input.vm, target, (input.waitSeconds ?? 120) * 1000) };
		}
	},
	{
		name: 'vmm_wait_for_state',
		title: 'Wait for a virtual machine state',
		description: 'Waits until a machine reaches a state (for example running after a start that was not waited for) and returns it.',
		inputSchema: {
			type: 'object',
			properties: { vm: vmParam, state: { type: 'string', description: 'The state to wait for.', enum: STATES }, waitSeconds: { type: 'integer', description: `At most this long (default 120, at most ${MAX_WAIT_SECONDS}).`, minimum: 1, maximum: MAX_WAIT_SECONDS } },
			required: ['vm', 'state'],
			additionalProperties: false
		},
		risk: () => 'read',
		describe: (input: { vm: string; state: string }) => `Wait until ${input.vm} is ${input.state}`,
		run: async (input: { vm: string; state: VmState; waitSeconds?: number }, backend) => ({ vm: await backend.waitForState(input.vm, input.state, (input.waitSeconds ?? 120) * 1000) })
	},
	{
		name: 'vmm_take_snapshot',
		title: 'Take a snapshot',
		description: 'Saves the current state of a machine as a named snapshot it can be reverted to later. Take one before risky changes inside the guest.',
		inputSchema: { type: 'object', properties: { vm: vmParam, name: { type: 'string', description: 'A short name, for example "before-upgrade".' } }, required: ['vm', 'name'], additionalProperties: false },
		risk: () => 'action',
		describe: (input: { vm: string; name: string }) => `Take snapshot "${input.name}" of ${input.vm}`,
		run: async (input: { vm: string; name: string }, backend) => ({ snapshot: await backend.takeSnapshot(input.vm, input.name) })
	},
	{
		name: 'vmm_revert_snapshot',
		title: 'Revert to a snapshot',
		description: 'Returns a machine to a snapshot, discarding everything changed since. Destructive: only allowed when the user enabled destructive actions.',
		inputSchema: { type: 'object', properties: { vm: vmParam, snapshot: { type: 'string', description: 'The snapshot id or name from vmm_list_snapshots.' } }, required: ['vm', 'snapshot'], additionalProperties: false },
		risk: () => 'destructive',
		describe: (input: { vm: string; snapshot: string }) => `Revert ${input.vm} to snapshot "${input.snapshot}", discarding all changes since`,
		run: async (input: { vm: string; snapshot: string }, backend) => ({ reverted: await backend.revertSnapshot(input.vm, input.snapshot) })
	},
	{
		name: 'vmm_delete_snapshot',
		title: 'Delete a snapshot',
		description: 'Deletes a snapshot of a machine. Destructive: only allowed when the user enabled destructive actions.',
		inputSchema: { type: 'object', properties: { vm: vmParam, snapshot: { type: 'string', description: 'The snapshot id or name from vmm_list_snapshots.' } }, required: ['vm', 'snapshot'], additionalProperties: false },
		risk: () => 'destructive',
		describe: (input: { vm: string; snapshot: string }) => `Delete snapshot "${input.snapshot}" of ${input.vm}`,
		run: async (input: { vm: string; snapshot: string }, backend) => ({ deleted: await backend.deleteSnapshot(input.vm, input.snapshot) })
	},
	{
		name: 'vmm_run_in_guest',
		title: 'Run a command in a virtual machine',
		description: 'Runs a program inside a running machine through its guest agent (qemu-guest-agent) and returns its exit code, stdout and stderr. Use shell=true for a command line with pipes or variables (/bin/sh -c, or cmd.exe /c on Windows). Each call is confirmed by the user.',
		inputSchema: {
			type: 'object',
			properties: {
				vm: vmParam,
				command: { type: 'string', description: 'The program (absolute path is safest), or with shell=true the whole command line.' },
				args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the program (without shell).' },
				shell: { type: 'boolean', description: 'Run command through the guest\'s shell.' },
				input: { type: 'string', description: 'Text given to the program on stdin.' },
				timeoutSeconds: { type: 'integer', description: 'How long to wait for it (default 60, at most 600). It keeps running in the guest after a timeout.', minimum: 1, maximum: 600 }
			},
			required: ['vm', 'command'],
			additionalProperties: false
		},
		risk: () => 'action',
		describe: (input: { vm: string; command: string; args?: string[]; shell?: boolean }) => `Run in ${input.vm}: ${input.shell ? input.command : [input.command, ...(input.args ?? [])].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
		run: async (input: { vm: string; command: string; args?: string[]; shell?: boolean; input?: string; timeoutSeconds?: number }, backend) => {
			const result = await backend.runInGuest(input.vm, { command: input.command, args: input.args, shell: input.shell, input: input.input, timeoutMs: (input.timeoutSeconds ?? 60) * 1000 });
			const stdout = clip(result.stdout);
			const stderr = clip(result.stderr);
			return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, truncated: result.truncated || stdout.cut || stderr.cut, stdout: stdout.text, stderr: stderr.text };
		}
	},
	{
		name: 'vmm_copy_to_guest',
		title: 'Copy a file into a virtual machine',
		description: 'Copies a file from this computer into a running machine through its guest agent, replacing the file at guestPath. Each call is confirmed by the user.',
		inputSchema: { type: 'object', properties: { vm: vmParam, localPath: { type: 'string', description: 'Absolute path of the file on this computer.' }, guestPath: { type: 'string', description: 'Absolute path in the guest.' } }, required: ['vm', 'localPath', 'guestPath'], additionalProperties: false },
		risk: () => 'action',
		describe: (input: { vm: string; localPath: string; guestPath: string }) => `Copy ${input.localPath} on this computer to ${input.guestPath} in ${input.vm}`,
		run: async (input: { vm: string; localPath: string; guestPath: string }, backend) => {
			await backend.copyToGuest(input.vm, input.localPath, input.guestPath);
			return { copied: true };
		}
	},
	{
		name: 'vmm_copy_from_guest',
		title: 'Copy a file out of a virtual machine',
		description: 'Copies a file from a running machine to this computer through its guest agent, replacing the file at localPath. Each call is confirmed by the user.',
		inputSchema: { type: 'object', properties: { vm: vmParam, guestPath: { type: 'string', description: 'Absolute path in the guest.' }, localPath: { type: 'string', description: 'Absolute path on this computer.' } }, required: ['vm', 'guestPath', 'localPath'], additionalProperties: false },
		risk: () => 'action',
		describe: (input: { vm: string; localPath: string; guestPath: string }) => `Copy ${input.guestPath} from ${input.vm} to ${input.localPath} on this computer`,
		run: async (input: { vm: string; localPath: string; guestPath: string }, backend) => {
			await backend.copyFromGuest(input.vm, input.guestPath, input.localPath);
			return { copied: true };
		}
	},
	{
		name: 'vmm_add_port_forward',
		title: 'Forward a port to a virtual machine',
		description: 'Forwards a port on this computer (localhost) to a port in a machine behind NAT, for example host 2222 to guest 22 for SSH. Only for providers with port forwarding (QEMU, local libvirt).',
		inputSchema: {
			type: 'object',
			properties: {
				vm: vmParam,
				hostPort: { type: 'integer', description: 'Port on this computer (1024-65535).', minimum: 1024, maximum: 65535 },
				guestPort: { type: 'integer', description: 'Port in the guest.', minimum: 1, maximum: 65535 },
				protocol: { type: 'string', description: 'tcp (default) or udp.', enum: ['tcp', 'udp'] }
			},
			required: ['vm', 'hostPort', 'guestPort'],
			additionalProperties: false
		},
		risk: () => 'action',
		describe: (input: { vm: string; hostPort: number; guestPort: number; protocol?: string }) => `Forward localhost:${input.hostPort} to port ${input.guestPort}/${input.protocol ?? 'tcp'} of ${input.vm}`,
		run: async (input: { vm: string; hostPort: number; guestPort: number; protocol?: 'tcp' | 'udp' }, backend) => {
			await backend.addPortForward(input.vm, { protocol: input.protocol ?? 'tcp', hostAddress: '127.0.0.1', hostPort: input.hostPort, guestPort: input.guestPort });
			return { forwarded: true, host: '127.0.0.1', port: input.hostPort };
		}
	},
	{
		name: 'vmm_screenshot',
		title: 'Take a screenshot of a virtual machine',
		description: 'Takes a screenshot of a running machine\'s display (its VNC console): a PNG of at most 1280 pixels on the longest side. Use it to see a graphical desktop, an installer, a login screen or boot messages, and to find where to click with vmm_mouse. Machines with a VNC display only (QEMU, libvirt, Proxmox, Nutanix; not Hyper-V).',
		inputSchema: { type: 'object', properties: { vm: vmParam }, required: ['vm'], additionalProperties: false },
		risk: () => 'read',
		describe: (input: { vm: string }) => `Take a screenshot of ${input.vm}`,
		run: async (input: { vm: string }, backend) => screenshotOutput(await backend.screenshot(input.vm))
	},
	{
		name: 'vmm_send_keys',
		title: 'Type on a virtual machine\'s keyboard',
		description: 'Types text and/or presses keys on a running machine\'s display, as if on its keyboard. text is typed character by character (US layout); keys are combinations pressed after it, in order, such as "enter", "ctrl+alt+delete", "alt+f4", "shift+tab", "f2". For a command line in the guest prefer vmm_run_in_guest. The user allows keyboard and mouse control per machine (usually once for 15 minutes); call vmm_release_control when done.',
		inputSchema: {
			type: 'object',
			properties: {
				vm: vmParam,
				text: { type: 'string', description: `Text to type (at most ${MAX_TEXT} characters; a newline presses Enter).` },
				keys: { type: 'array', items: { type: 'string' }, description: 'Key combinations to press after the text, in order: "enter", "ctrl+c", "ctrl+alt+delete", "f12", …' },
				screenshotAfter: screenshotAfterParam
			},
			required: ['vm'],
			additionalProperties: false
		},
		risk: () => 'control',
		describe: (input: { vm: string; text?: string; keys?: string[] }) => {
			const text = input.text ? `type "${input.text.length > 40 ? `${input.text.slice(0, 40)}…` : input.text}"` : '';
			const keys = input.keys?.length ? `press ${input.keys.join(', ')}` : '';
			return `On ${input.vm}: ${[text, keys].filter(Boolean).join(', then ') || 'nothing'}`;
		},
		run: async (input: { vm: string; text?: string; keys?: string[]; screenshotAfter?: boolean }, backend) => {
			if (!input.text && !input.keys?.length) throw new Error('Give text to type, keys to press, or both.');
			if (input.text && input.text.length > MAX_TEXT) throw new Error(`text is longer than ${MAX_TEXT} characters: send it in parts.`);
			const strokes = [...textStrokes(input.text ?? ''), ...(input.keys ?? []).flatMap((k) => comboStrokes(k))];
			await backend.sendKeys(input.vm, strokes);
			const done = { typed: input.text?.length ?? 0, pressed: input.keys ?? [] };
			return input.screenshotAfter ? screenshotOutput(await backend.screenshot(input.vm, { settleMs: SETTLE_MS }), done) : done;
		}
	},
	{
		name: 'vmm_mouse',
		title: 'Use a virtual machine\'s mouse',
		description: 'Moves, clicks, drags or scrolls the mouse on a running machine\'s display. x and y are pixels of the latest vmm_screenshot (0,0 is the top left). Take a screenshot first to know where things are. The user allows keyboard and mouse control per machine (usually once for 15 minutes); call vmm_release_control when done.',
		inputSchema: {
			type: 'object',
			properties: {
				vm: vmParam,
				action: { type: 'string', description: 'What to do at (x, y).', enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll'] },
				x: { type: 'integer', description: 'Horizontal position in screenshot pixels.', minimum: 0 },
				y: { type: 'integer', description: 'Vertical position in screenshot pixels.', minimum: 0 },
				toX: { type: 'integer', description: 'For drag: where to release, horizontally.', minimum: 0 },
				toY: { type: 'integer', description: 'For drag: where to release, vertically.', minimum: 0 },
				direction: { type: 'string', description: 'For scroll: up or down (default down).', enum: ['up', 'down'] },
				amount: { type: 'integer', description: 'For scroll: how many wheel steps (default 3).', minimum: 1, maximum: 50 },
				screenshotAfter: screenshotAfterParam
			},
			required: ['vm', 'action', 'x', 'y'],
			additionalProperties: false
		},
		risk: () => 'control',
		describe: (input: { vm: string; action: string; x: number; y: number; toX?: number; toY?: number }) =>
			`On ${input.vm}: ${input.action.replace('_', ' ')} at (${input.x}, ${input.y})${input.action === 'drag' ? ` to (${input.toX}, ${input.toY})` : ''}`,
		run: async (input: { vm: string; action: MouseAction['action']; x: number; y: number; toX?: number; toY?: number; direction?: 'up' | 'down'; amount?: number; screenshotAfter?: boolean }, backend) => {
			let action: MouseAction;
			if (input.action === 'drag') {
				if (input.toX === undefined || input.toY === undefined) throw new Error('A drag needs toX and toY.');
				action = { action: 'drag', x: input.x, y: input.y, toX: input.toX, toY: input.toY };
			} else if (input.action === 'scroll') {
				action = { action: 'scroll', x: input.x, y: input.y, direction: input.direction ?? 'down', amount: input.amount ?? 3 };
			} else {
				action = { action: input.action, x: input.x, y: input.y };
			}
			await backend.mouse(input.vm, action);
			const done = { done: input.action, at: { x: input.x, y: input.y } };
			return input.screenshotAfter ? screenshotOutput(await backend.screenshot(input.vm, { settleMs: SETTLE_MS }), done) : done;
		}
	},
	{
		name: 'vmm_release_control',
		title: 'Hand back a virtual machine\'s keyboard and mouse',
		description: 'Ends keyboard and mouse control of a machine when the task on its screen is done: the user sees that the agent stopped, and the next vmm_send_keys or vmm_mouse asks the user again. Always call it when finished with vmm_send_keys / vmm_mouse.',
		inputSchema: { type: 'object', properties: { vm: vmParam }, required: ['vm'], additionalProperties: false },
		risk: () => 'read',
		describe: (input: { vm: string }) => `Hand back the keyboard and mouse of ${input.vm}`,
		run: async (input: { vm: string }, backend) => backend.releaseControl(input.vm)
	}
];

export function findTool(name: string): AgentTool | undefined {
	return TOOLS.find((t) => t.name === name);
}

/** Checks an input against a tool's schema. Returns the first problem, or undefined. */
export function validateInput(schema: InputSchema, input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'The input must be an object.';
	const value = input as Record<string, unknown>;
	for (const key of schema.required ?? []) if (value[key] === undefined || value[key] === null || value[key] === '') return `"${key}" is required.`;
	for (const [key, given] of Object.entries(value)) {
		const property = schema.properties[key];
		if (!property) { if (schema.additionalProperties === false) return `Unknown parameter "${key}".`; continue; }
		if (given === undefined || given === null) continue;
		switch (property.type) {
			case 'string':
				if (typeof given !== 'string') return `"${key}" must be a string.`;
				if (property.enum && !property.enum.includes(given)) return `"${key}" must be one of ${property.enum.join(', ')}.`;
				break;
			case 'boolean':
				if (typeof given !== 'boolean') return `"${key}" must be true or false.`;
				break;
			case 'number':
			case 'integer':
				if (typeof given !== 'number' || !Number.isFinite(given) || (property.type === 'integer' && !Number.isInteger(given))) return `"${key}" must be ${property.type === 'integer' ? 'a whole number' : 'a number'}.`;
				if (property.minimum !== undefined && given < property.minimum) return `"${key}" must be at least ${property.minimum}.`;
				if (property.maximum !== undefined && given > property.maximum) return `"${key}" must be at most ${property.maximum}.`;
				break;
			case 'array':
				if (!Array.isArray(given) || given.some((item) => typeof item !== 'string')) return `"${key}" must be a list of strings.`;
				break;
		}
	}
	return undefined;
}

/** Why an agent may not make this call, or undefined when it may (after the user's confirmation for actions). */
export function refusal(risk: Risk, allowDestructive: boolean): string | undefined {
	// `control` is not refused here: the user allows it per machine (see the agent's index).
	return risk === 'destructive' && !allowDestructive
		? 'Destructive actions (power off, reset, revert or delete a snapshot) are turned off for AI agents. The user can allow them with the setting vmm.agent.allowDestructive.'
		: undefined;
}
