import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildArgs, defaultAccelerators, splitArgs, type VmDefinition } from '../src/definition';
import { QmpClient, type QmpEvent } from '../src/QmpClient';

const def: VmDefinition = {
	id: '00000000-0000-0000-0000-000000000000',
	name: 'web, prod',
	cpus: 2,
	memoryMB: 2048,
	cpuModel: 'max',
	firmware: 'uefi',
	disks: ['/vms/a/disk0.qcow2'],
	diskBus: 'virtio',
	cdrom: '/isos/debian.iso',
	nic: 'e1000',
	vga: 'std',
	serial: true,
	extraArgs: '-device virtio-rng-pci -smbios "type=1,serial=a b"',
	createdAt: 0
};
const runtime = { pid: 1, qmpPort: 4444, vncPort: 5903, serialPort: 4445, startedAt: 0 };

describe('splitArgs', () => {
	it('splits on whitespace and honours quotes', () => {
		expect(splitArgs(`-a 'b c' "d e" f""`)).toEqual(['-a', 'b c', 'd e', 'f']);
		expect(splitArgs(`-x ""`)).toEqual(['-x', '']);
		expect(splitArgs(undefined)).toEqual([]);
	});
});

describe('buildArgs', () => {
	const args = buildArgs(def, runtime, { accelerators: ['kvm', 'tcg'], firmwareCode: '/fw/code.fd', firmwareVars: '/vms/a/vars.fd' });
	const value = (flag: string) => args.filter((_, i) => args[i - 1] === flag);

	it('escapes commas in option values', () => {
		expect(value('-name')).toEqual(['web,, prod']);
	});

	it('wires accelerators, cpu and memory', () => {
		expect(value('-accel')).toEqual(['kvm', 'tcg']);
		expect(value('-smp')).toEqual(['2']);
		expect(value('-m')).toEqual(['2048M']);
	});

	it('adds UEFI flash, disks and the CD with boot order', () => {
		expect(value('-drive')).toEqual([
			'if=pflash,format=raw,readonly=on,file=/fw/code.fd',
			'if=pflash,format=raw,file=/vms/a/vars.fd',
			'file=/vms/a/disk0.qcow2,if=none,id=disk0,format=qcow2',
			'file=/isos/debian.iso,if=none,id=cd0,media=cdrom,readonly=on'
		]);
		expect(value('-device')).toContain('virtio-blk-pci,drive=disk0,bootindex=1');
		expect(value('-device')).toContain('ide-cd,drive=cd0,bus=ide.5,bootindex=2');
	});

	it('binds VNC, QMP and serial to localhost only', () => {
		expect(value('-vnc')).toEqual(['127.0.0.1:3']);
		expect(value('-qmp')).toEqual(['tcp:127.0.0.1:4444,server=on,wait=off']);
		expect(value('-chardev')[0]).toContain('host=127.0.0.1,port=4445');
		expect(value('-display')).toEqual(['none']);
	});

	it('appends extra args without a shell', () => {
		expect(args.slice(-4)).toEqual(['-device', 'virtio-rng-pci', '-smbios', 'type=1,serial=a b']);
	});

	it('requires firmware for UEFI guests', () => {
		expect(() => buildArgs(def, runtime, { accelerators: ['tcg'] })).toThrow(/UEFI firmware/);
	});

	it('uses SATA and disables serial when asked', () => {
		const sata = buildArgs({ ...def, firmware: 'bios', diskBus: 'sata', serial: false, cdrom: undefined, extraArgs: undefined }, runtime, {
			accelerators: ['tcg']
		});
		expect(sata).toContain('ide-hd,drive=disk0,bus=ide.0,bootindex=1');
		expect(sata.join(' ')).toContain('-serial none');
	});

	it('adds the stored port forwards to the NIC', () => {
		const withForwards = buildArgs({ ...def, nic: 'e1000', forwards: [{ protocol: 'tcp', hostPort: 2222, guestPort: 22 }] }, runtime, { accelerators: ['tcg'], firmwareCode: '/fw/code.fd' });
		expect(withForwards[withForwards.indexOf('-nic') + 1]).toMatch(/^user,model=e1000.*,hostfwd=tcp:127\.0\.0\.1:2222-:22$/);
	});
});

describe('defaultAccelerators', () => {
	it('picks the platform hypervisor with TCG fallback', () => {
		expect(defaultAccelerators('win32')).toEqual(['whpx,kernel-irqchip=off', 'tcg']);
		expect(defaultAccelerators('linux')).toEqual(['kvm', 'tcg']);
		expect(defaultAccelerators('darwin')).toEqual(['hvf', 'tcg']);
		expect(defaultAccelerators('linux', 'tcg')).toEqual(['tcg']);
	});
});

describe('QmpClient', () => {
	let server: net.Server | undefined;
	afterEach(() => server?.close());

	function fakeQemu(socketPath?: string): Promise<{ port: number; sockets: net.Socket[] }> {
		const sockets: net.Socket[] = [];
		server = net.createServer((socket) => {
			sockets.push(socket);
			socket.write('{"QMP": {"version": {}, "capabilities": []}}\r\n');
			let buffer = '';
			socket.on('data', (chunk) => {
				buffer += chunk.toString();
				let i: number;
				while ((i = buffer.indexOf('\n')) >= 0) {
					const message = JSON.parse(buffer.slice(0, i));
					buffer = buffer.slice(i + 1);
					if (message.execute === 'query-status') socket.write(`{"return": {"status": "running", "running": true}, "id": "${message.id}"}\r\n`);
					else if (message.execute === 'bogus') socket.write(`{"error": {"class": "CommandNotFound", "desc": "nope"}, "id": "${message.id}"}\r\n`);
					else socket.write(`{"return": {}, "id": "${message.id}"}\r\n`);
				}
			});
		});
		if (socketPath) return new Promise((resolve) => server!.listen(socketPath, () => resolve({ port: 0, sockets })));
		return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve({ port: (server!.address() as net.AddressInfo).port, sockets })));
	}

	it.skipIf(process.platform === 'win32')('talks over a unix socket', async () => {
		const socketPath = path.join(os.tmpdir(), `vmm-qmp-${process.pid}.sock`);
		await fakeQemu(socketPath);
		const client = await QmpClient.connectSocket(socketPath);
		await expect(client.execute('query-status')).resolves.toEqual({ status: 'running', running: true });
		client.close();
	});

	it('negotiates capabilities, executes commands and reports errors', async () => {
		const { port } = await fakeQemu();
		const client = await QmpClient.connect(port);
		await expect(client.execute('query-status')).resolves.toEqual({ status: 'running', running: true });
		await expect(client.execute('bogus')).rejects.toThrow('nope');
		client.close();
		expect(client.isClosed).toBe(true);
	});

	it('emits asynchronous events', async () => {
		const { port, sockets } = await fakeQemu();
		const client = await QmpClient.connect(port);
		const event = new Promise<QmpEvent>((resolve) => client.once('event', resolve));
		sockets[0].write('{"event": "SHUTDOWN", "data": {"guest": true}, "timestamp": {"seconds": 1, "microseconds": 2}}\r\n');
		expect((await event).event).toBe('SHUTDOWN');
		client.close();
	});
});
