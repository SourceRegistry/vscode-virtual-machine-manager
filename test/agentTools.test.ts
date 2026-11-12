import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@vmm/sdk';
import { MAX_OUTPUT_CHARS, TOOLS, findTool, refusal, validateInput, type AgentBackend, type AgentVm } from '../src/extension/agent/tools';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

const web: AgentVm = { id: 'c/n/1', name: 'web-01', cluster: 'Local', node: 'mac', state: 'running', ipAddresses: ['10.0.2.15'], cpus: 2, memoryMB: 2048, favorite: false, groups: [] };
const db: AgentVm = { ...web, id: 'c/n/2', name: 'db-01', state: 'stopped', ipAddresses: [] };
const caps: Capabilities = { create: true, edit: true, delete: true, power: ['start', 'shutdown', 'stop'], consoles: ['vnc'], preview: false, external: false, details: true, snapshots: true, guestExec: true };

function backend(overrides: Partial<AgentBackend> = {}): AgentBackend {
	return {
		clusters: vi.fn().mockResolvedValue([{ name: 'Local', provider: 'qemu', status: 'connected', nodes: [{ name: 'mac', status: 'online', vms: 2 }] }]),
		list: vi.fn().mockResolvedValue([web, db]),
		get: vi.fn().mockResolvedValue({ vm: web, capabilities: caps }),
		details: vi.fn().mockResolvedValue({ disks: [], nics: [], devices: [], forwards: [] }),
		stats: vi.fn().mockResolvedValue({ timestamp: 1, cpuUsage: 0.5 }),
		snapshots: vi.fn().mockResolvedValue([]),
		address: vi.fn().mockResolvedValue(undefined),
		power: vi.fn().mockResolvedValue(undefined),
		waitForState: vi.fn().mockResolvedValue({ ...db, state: 'running' }),
		takeSnapshot: vi.fn().mockResolvedValue({ id: 's1', name: 'before' }),
		revertSnapshot: vi.fn(),
		deleteSnapshot: vi.fn(),
		runInGuest: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false }),
		copyToGuest: vi.fn(),
		copyFromGuest: vi.fn(),
		addPortForward: vi.fn(),
		...overrides
	};
}

describe('agent tool declarations', () => {
	it('declares every tool in package.json exactly as defined in tools.ts', () => {
		const declared = pkg.contributes.languageModelTools as Array<{ name: string; displayName: string; modelDescription: string; inputSchema: unknown; toolReferenceName: string }>;
		expect(declared.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
		for (const tool of TOOLS) {
			const entry = declared.find((t) => t.name === tool.name)!;
			expect(entry.displayName, tool.name).toBe(tool.title);
			expect(entry.modelDescription, tool.name).toBe(tool.description);
			expect(entry.inputSchema, tool.name).toEqual(tool.inputSchema);
			expect(entry.toolReferenceName).toMatch(/^vm_\w+$/);
		}
	});

	it('names tools the way both VS Code and MCP accept, and requires only declared properties', () => {
		for (const tool of TOOLS) {
			expect(tool.name).toMatch(/^vmm_[a-z_]{3,60}$/);
			for (const key of tool.inputSchema.required ?? []) expect(tool.inputSchema.properties, `${tool.name}.${key}`).toHaveProperty(key);
			expect(tool.inputSchema.additionalProperties).toBe(false);
		}
	});

	it('declares the MCP settings off by default and destructive calls refused by default', () => {
		const settings = pkg.contributes.configuration.flatMap((g: { properties: Record<string, { default: unknown }> }) => Object.entries(g.properties));
		const get = (key: string) => settings.find(([k]: [string]) => k === key)?.[1];
		expect(get('vmm.mcp.enabled').default).toBe(false);
		expect(get('vmm.agent.allowDestructive').default).toBe(false);
		expect(get('vmm.mcp.port').default).toBeGreaterThanOrEqual(1024);
	});
});

describe('agent tool risks', () => {
	const risk = (name: string, input: Record<string, unknown> = {}) => findTool(name)!.risk(input);
	it('reads without asking, asks for actions, and treats data loss as destructive', () => {
		for (const name of ['vmm_list_clusters', 'vmm_list_vms', 'vmm_get_vm', 'vmm_get_vm_stats', 'vmm_list_snapshots', 'vmm_get_vm_address', 'vmm_wait_for_state']) expect(risk(name), name).toBe('read');
		for (const name of ['vmm_take_snapshot', 'vmm_run_in_guest', 'vmm_copy_to_guest', 'vmm_copy_from_guest', 'vmm_add_port_forward']) expect(risk(name), name).toBe('action');
		for (const name of ['vmm_revert_snapshot', 'vmm_delete_snapshot']) expect(risk(name), name).toBe('destructive');
		expect(risk('vmm_power_vm', { action: 'start' })).toBe('action');
		expect(risk('vmm_power_vm', { action: 'shutdown' })).toBe('action');
		expect(risk('vmm_power_vm', { action: 'stop' })).toBe('destructive');
		expect(risk('vmm_power_vm', { action: 'reset' })).toBe('destructive');
	});
	it('refuses destructive calls unless the user allowed them', () => {
		expect(refusal('destructive', false)).toMatch(/vmm\.agent\.allowDestructive/);
		expect(refusal('destructive', true)).toBeUndefined();
		expect(refusal('action', false)).toBeUndefined();
	});
	it('describes what will happen in the confirmation', () => {
		expect(findTool('vmm_power_vm')!.describe({ vm: 'web-01', action: 'stop' })).toBe('Power off (no clean shutdown) web-01');
		expect(findTool('vmm_run_in_guest')!.describe({ vm: 'web-01', command: '/usr/bin/apt', args: ['install', '-y', 'a b'] })).toBe('Run in web-01: /usr/bin/apt install -y "a b"');
		expect(findTool('vmm_run_in_guest')!.describe({ vm: 'web-01', command: 'df -h | tail -1', shell: true })).toBe('Run in web-01: df -h | tail -1');
	});
});

describe('agent tool input checks', () => {
	const schema = findTool('vmm_power_vm')!.inputSchema;
	it('accepts a valid input', () => expect(validateInput(schema, { vm: 'web', action: 'start', wait: true, waitSeconds: 30 })).toBeUndefined());
	it('names the first problem', () => {
		expect(validateInput(schema, { action: 'start' })).toBe('"vm" is required.');
		expect(validateInput(schema, { vm: 'web', action: 'explode' })).toMatch(/one of start, shutdown/);
		expect(validateInput(schema, { vm: 'web', action: 'start', wait: 'yes' })).toBe('"wait" must be true or false.');
		expect(validateInput(schema, { vm: 'web', action: 'start', waitSeconds: 1.5 })).toBe('"waitSeconds" must be a whole number.');
		expect(validateInput(schema, { vm: 'web', action: 'start', waitSeconds: 9999 })).toBe('"waitSeconds" must be at most 600.');
		expect(validateInput(schema, { vm: 'web', action: 'start', force: true })).toBe('Unknown parameter "force".');
		expect(validateInput(schema, null)).toBe('The input must be an object.');
		expect(validateInput(findTool('vmm_run_in_guest')!.inputSchema, { vm: 'w', command: 'ls', args: ['-l', 3] })).toBe('"args" must be a list of strings.');
	});
});

describe('agent tools against a backend', () => {
	const run = (name: string, input: Record<string, unknown>, b: AgentBackend) => findTool(name)!.run(input, b);
	it('filters the machine list', async () => {
		const b = backend();
		expect(await run('vmm_list_vms', { state: 'running' }, b)).toEqual({ count: 1, vms: [web] });
		expect(await run('vmm_list_vms', { name: 'DB' }, b)).toEqual({ count: 1, vms: [db] });
		expect(await run('vmm_list_vms', { cluster: 'Other' }, b)).toEqual({ count: 0, vms: [] });
	});
	it('describes a machine with what can be done with it', async () => {
		const result = (await run('vmm_get_vm', { vm: 'web-01' }, backend())) as { can: string[]; details: unknown };
		expect(result.can).toEqual(['power:start', 'power:shutdown', 'power:stop', 'details', 'snapshots', 'run_in_guest']);
		expect(result.details).toEqual({ disks: [], nics: [], devices: [], forwards: [] });
	});
	it('starts and waits for running, shuts down and waits for stopped', async () => {
		const b = backend();
		await run('vmm_power_vm', { vm: 'db-01', action: 'start', wait: true, waitSeconds: 30 }, b);
		expect(b.power).toHaveBeenCalledWith('db-01', 'start');
		expect(b.waitForState).toHaveBeenCalledWith('db-01', 'running', 30_000);
		await run('vmm_power_vm', { vm: 'web-01', action: 'shutdown', wait: true }, b);
		expect(b.waitForState).toHaveBeenLastCalledWith('web-01', 'stopped', 120_000);
		expect(await run('vmm_power_vm', { vm: 'web-01', action: 'reboot' }, b)).toEqual({ requested: 'reboot' });
	});
	it('passes a guest command through and cuts long output', async () => {
		const long = 'x'.repeat(MAX_OUTPUT_CHARS + 10);
		const b = backend({ runInGuest: vi.fn().mockResolvedValue({ exitCode: 1, stdout: long, stderr: 'oops', truncated: false, timedOut: false }) });
		const result = (await run('vmm_run_in_guest', { vm: 'web-01', command: 'cat', args: ['/var/log/syslog'], timeoutSeconds: 5 }, b)) as { exitCode: number; stdout: string; truncated: boolean };
		expect(b.runInGuest).toHaveBeenCalledWith('web-01', { command: 'cat', args: ['/var/log/syslog'], shell: undefined, input: undefined, timeoutMs: 5000 });
		expect(result.exitCode).toBe(1);
		expect(result.truncated).toBe(true);
		expect(result.stdout).toMatch(/10 more characters cut/);
	});
	it('explains a missing address instead of failing', async () => {
		expect(await run('vmm_get_vm_address', { vm: 'db-01', ssh: true }, backend())).toMatchObject({ found: false, hint: expect.stringMatching(/stopped/) });
		const b = backend({ address: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 2222 }) });
		expect(await run('vmm_get_vm_address', { vm: 'web-01', ssh: true, waitSeconds: 10 }, b)).toEqual({ found: true, host: '127.0.0.1', port: 2222 });
		expect(b.address).toHaveBeenCalledWith('web-01', { ssh: true, timeoutMs: 10_000 });
	});
	it('forwards a port on the loopback interface only', async () => {
		const b = backend();
		await run('vmm_add_port_forward', { vm: 'web-01', hostPort: 2222, guestPort: 22 }, b);
		expect(b.addPortForward).toHaveBeenCalledWith('web-01', { protocol: 'tcp', hostAddress: '127.0.0.1', hostPort: 2222, guestPort: 22 });
	});
});
