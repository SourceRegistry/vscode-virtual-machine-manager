import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildArgs, type VmDefinition } from '../src/definition';
import { GuestAgentClient } from '../src/GuestAgent';
import { gracefulShutdown, type ShutdownSteps } from '../src/shutdown';

function steps(over: Partial<ShutdownSteps> & { stopsAfter?: 'agent' | 'acpi' | 'never' } = {}) {
	const calls: string[] = [];
	const result: ShutdownSteps = {
		agent: over.agent ?? (async () => {
			calls.push('agent');
			return false;
		}),
		acpi: async () => {
			calls.push('acpi');
		},
		waitStopped: async (ms) => {
			calls.push(`wait:${ms}`);
			const last = calls.filter((c) => c === 'agent' || c === 'acpi').pop();
			return over.stopsAfter === last;
		}
	};
	return { result, calls };
}

describe('gracefulShutdown', () => {
	it('falls through to ACPI when no agent answers', async () => {
		const { result, calls } = steps({ stopsAfter: 'acpi' });
		await expect(gracefulShutdown(result, 30_000, 'vm')).resolves.toBe('acpi');
		expect(calls).toEqual(['agent', 'acpi', 'wait:30000']);
	});

	it('uses only the agent when the guest follows it', async () => {
		const calls: string[] = [];
		const result: ShutdownSteps = {
			agent: async () => true,
			acpi: async () => void calls.push('acpi'),
			waitStopped: async (ms) => {
				calls.push(`wait:${ms}`);
				return true;
			}
		};
		await expect(gracefulShutdown(result, 30_000, 'vm')).resolves.toBe('agent');
		expect(calls).toEqual(['wait:10000']);
	});

	it('sends ACPI too when the agent request is ignored', async () => {
		const calls: string[] = [];
		let waits = 0;
		const result: ShutdownSteps = {
			agent: async () => true,
			acpi: async () => void calls.push('acpi'),
			waitStopped: async (ms) => {
				calls.push(`wait:${ms}`);
				return ++waits === 2;
			}
		};
		await gracefulShutdown(result, 30_000, 'vm');
		expect(calls).toEqual(['wait:10000', 'acpi', 'wait:20000']);
	});

	it('works without an agent step', async () => {
		const { result } = steps({ stopsAfter: 'acpi' });
		delete result.agent;
		await expect(gracefulShutdown(result, 5000, 'vm')).resolves.toBe('acpi');
	});

	it('throws a timeout error when the guest ignores everything', async () => {
		const { result } = steps({ stopsAfter: 'never' });
		await expect(gracefulShutdown(result, 30_000, 'web')).rejects.toMatchObject({
			code: 'timeout',
			message: expect.stringContaining('web did not shut down within 30 seconds')
		});
	});

	it('treats a failing agent as absent', async () => {
		const { result, calls } = steps({ stopsAfter: 'acpi', agent: async () => Promise.reject(new Error('boom')) });
		await expect(gracefulShutdown(result, 30_000, 'vm')).resolves.toBe('acpi');
		expect(calls).toContain('acpi');
	});
});

describe('GuestAgentClient', () => {
	let server: net.Server | undefined;
	afterEach(() => {
		server?.close();
		server = undefined;
		vi.useRealTimers();
	});

	function listen(onLine: (line: Record<string, unknown>, socket: net.Socket) => void): Promise<number> {
		return new Promise((resolve) => {
			server = net.createServer((socket) => {
				let buf = '';
				socket.on('data', (d) => {
					// 0xFF must arrive as one byte: the agent resynchronises on it.
					if (d.includes(0xc3) && d.includes(0xbf, d.indexOf(0xc3))) throw new Error('delimiter was UTF-8 encoded');
					buf += d.toString('latin1');
					let i: number;
					while ((i = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, i).replace(/\xff/g, '');
						buf = buf.slice(i + 1);
						onLine(JSON.parse(line) as Record<string, unknown>, socket);
					}
				});
			});
			server.listen(0, '127.0.0.1', () => resolve((server!.address() as net.AddressInfo).port));
		});
	}

	it('syncs, then sends guest-shutdown with the requested mode', async () => {
		const seen: Array<Record<string, unknown>> = [];
		const port = await listen((line, socket) => {
			seen.push(line);
			if (line.execute === 'guest-sync-delimited') {
				const id = (line.arguments as { id: number }).id;
				socket.write(`\xff${JSON.stringify({ return: id })}\n`, 'latin1');
			}
		});
		const agent = await GuestAgentClient.connect(port, 1000);
		await agent.shutdown('reboot');
		await new Promise((r) => setTimeout(r, 50));
		agent.close();
		expect(seen.map((l) => l.execute)).toEqual(['guest-sync-delimited', 'guest-shutdown']);
		expect(seen[1]!.arguments).toEqual({ mode: 'reboot' });
	});

	it('rejects when nothing in the guest answers the sync', async () => {
		const port = await listen(() => undefined);
		await expect(GuestAgentClient.connect(port, 150)).rejects.toThrow(/No guest agent/);
	});

	it('rejects when the port is closed', async () => {
		const port = await listen(() => undefined);
		server!.close();
		await expect(GuestAgentClient.connect(port, 150)).rejects.toThrow();
	});
});

describe('buildArgs guest agent channel', () => {
	const def = {
		id: 'x', name: 'a', cpus: 1, memoryMB: 512, cpuModel: 'max', firmware: 'bios', disks: [], diskBus: 'sata',
		nic: 'none', vga: 'std', serial: false, createdAt: 0
	} as VmDefinition;

	it('adds a virtio-serial agent port only when the runtime has one', () => {
		const withAgent = buildArgs(def, { pid: 1, qmpPort: 1, vncPort: 5900, agentPort: 4242, startedAt: 0 }, { accelerators: ['tcg'] });
		expect(withAgent).toContain('virtio-serial-pci');
		expect(withAgent).toContain('virtserialport,chardev=qga0,name=org.qemu.guest_agent.0');
		expect(withAgent.join(' ')).toContain('socket,id=qga0,host=127.0.0.1,port=4242,server=on,wait=off');
		const without = buildArgs(def, { pid: 1, qmpPort: 1, vncPort: 5900, startedAt: 0 }, { accelerators: ['tcg'] });
		expect(without).not.toContain('virtio-serial-pci');
	});
});
