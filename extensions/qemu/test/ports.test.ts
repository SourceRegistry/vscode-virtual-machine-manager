import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isPortConflict, SerialQueue } from '../src/ports';
import { freePort } from '../src/QemuProvider';

describe('isPortConflict', () => {
	it('recognises the QEMU VNC error', () => {
		expect(isPortConflict('qemu-system-x86_64: -vnc 127.0.0.1:0: Failed to find an available port: Address already in use')).toBe(true);
	});
	it('recognises a bind failure', () => {
		expect(isPortConflict("Failed to bind socket to 127.0.0.1:4444: Address already in use")).toBe(true);
	});
	it('ignores other errors', () => {
		expect(isPortConflict('qemu-system-x86_64: could not open disk image')).toBe(false);
	});
});

describe('SerialQueue', () => {
	it('never runs two tasks at once and keeps order', async () => {
		const queue = new SerialQueue();
		let active = 0;
		let maxActive = 0;
		const order: number[] = [];
		const task = (n: number) => async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 10));
			order.push(n);
			active--;
			return n;
		};
		const results = await Promise.all([queue.run(task(1)), queue.run(task(2)), queue.run(task(3))]);
		expect(results).toEqual([1, 2, 3]);
		expect(order).toEqual([1, 2, 3]);
		expect(maxActive).toBe(1);
	});

	it('keeps going after a failing task', async () => {
		const queue = new SerialQueue();
		const failed = queue.run(async () => {
			throw new Error('boom');
		});
		const next = queue.run(async () => 'ok');
		await expect(failed).rejects.toThrow('boom');
		await expect(next).resolves.toBe('ok');
	});
});

// Bases come from the OS: fixed ports can sit in a range Windows reserves for Hyper-V, where
// listening fails with EACCES. The ranges are wider than one reserved block (100 ports).
const osPort = (server = net.createServer()) =>
	new Promise<number>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
	});

describe('freePort avoid', () => {
	it('skips avoided ports in a range', async () => {
		const probe = net.createServer();
		const base = await osPort(probe);
		probe.close();
		const first = await freePort(base, base + 200);
		const second = await freePort(base, base + 200, new Set([first]));
		expect(second).not.toBe(first);
	});

	it('skips a port that is really in use', async () => {
		const server = net.createServer();
		const base = await osPort(server);
		try {
			expect(await freePort(base, base + 200)).toBeGreaterThan(base);
		} finally {
			server.close();
		}
	});

	it('fails when the whole range is avoided', async () => {
		await expect(freePort(41030, 41031, new Set([41030, 41031]))).rejects.toThrow('No free TCP port');
	});
});
