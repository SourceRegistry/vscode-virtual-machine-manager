import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'pve-client';
import { connectionOptions, hasDisplay, ProxmoxConnection, proxmoxConsoles } from '../src/ProxmoxProvider';

const cluster = { id: 'test', name: 'Test', providerId: 'proxmox', config: { endpoint: 'https://pve.test:8006', tokenId: 'user@pve!vscode' } };
function fixture() {
	const request = vi.fn().mockResolvedValue({ status: 'stopped', exitstatus: 'OK' });
	const config = { get: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({ name: 'test', memory: 2048, cores: 2, onboot: 1 }), update: vi.fn().mockResolvedValue(null) };
	const status = { start: vi.fn().mockResolvedValue('UPID:test'), current: vi.fn().mockResolvedValue({ diskread: 1000, diskwrite: 2000, disk: 3000, maxdisk: 4000, uptime: 123, cpu: 0.2, mem: 1048576, maxmem: 2147483648, netin: 12, netout: 34 }) };
	const qemu = { list: vi.fn().mockResolvedValue([{ vmid: 100, name: 'test', status: 'running', maxmem: 2147483648 }, { vmid: 101, template: 1 }]), vmid: vi.fn().mockReturnValue({ config, status }) };
	const lxc = { list: vi.fn().mockResolvedValue([]), id: vi.fn().mockReturnValue({ config, status, destroy: vi.fn().mockResolvedValue('UPID:delete') }) };
	const client = { request, api: { nodes: { list: vi.fn().mockResolvedValue([{ node: 'pve', status: 'online', maxmem: 4294967296, mem: 1048576 }]), get: vi.fn().mockReturnValue({ qemu, lxc, storage: { list: vi.fn().mockResolvedValue([{ storage: 'local-lvm', active: 1, enabled: 1, content: 'images,rootdir' }]) } }) }, cluster: { resources: { index: vi.fn().mockResolvedValue([]) }, nextid: vi.fn().mockResolvedValue('100') } }, events: { stopListening: vi.fn() } };
	const open = vi.fn();
	return { connection: new ProxmoxConnection(client as unknown as Client, 'https://pve.test:8006', open), client, request, status, config, open, lxc };
}

describe('Proxmox console choice', () => {
	it('gives a container its terminal, from the resource type alone', () => {
		expect(proxmoxConsoles(true, undefined)).toEqual(['serial']);
		expect(proxmoxConsoles(true, { vga: 'std' })).toEqual(['serial']);
	});

	it('gives a VM with a display only the display, even with a serial port', () => {
		expect(proxmoxConsoles(false, { serial0: 'socket' })).toEqual(['vnc']);
		expect(proxmoxConsoles(false, { vga: 'virtio,memory=32', serial0: 'socket' })).toEqual(['vnc']);
		expect(proxmoxConsoles(false, undefined)).toEqual(['vnc']);
	});

	it('gives a display-less VM the terminal only when a serial socket exists', () => {
		expect(proxmoxConsoles(false, { vga: 'serial0', serial0: 'socket' })).toEqual(['serial']);
		expect(proxmoxConsoles(false, { vga: 'serial1', serial1: 'socket' })).toEqual(['serial']);
		expect(proxmoxConsoles(false, { vga: 'none', serial0: 'socket' })).toEqual(['serial']);
		expect(proxmoxConsoles(false, { vga: 'serial0' })).toEqual([]);
		expect(proxmoxConsoles(false, { vga: 'none', serial0: '/dev/ttyS0' })).toEqual([]);
	});

	it('reads the display type from vga', () => {
		expect(hasDisplay({})).toBe(true);
		expect(hasDisplay({ vga: 'qxl' })).toBe(true);
		expect(hasDisplay({ vga: 'serial2' })).toBe(false);
		expect(hasDisplay({ vga: 'none' })).toBe(false);
	});
});

describe('Proxmox provider', () => {
	it('validates HTTPS origins and API credentials', () => {
		expect(connectionOptions(cluster, { tokenSecret: 'secret' })).toMatchObject({ verifyTls: true, apiToken: 'user@pve!vscode=secret' });
		expect(connectionOptions({ ...cluster, config: { ...cluster.config, verifyTls: false } }, { tokenSecret: 'secret' }).verifyTls).toBe(false);
		for (const endpoint of ['http://pve.test', 'https://user:pass@pve.test', 'https://pve.test/api2/json', 'invalid']) expect(() => connectionOptions({ ...cluster, config: { ...cluster.config, endpoint } }, { tokenSecret: 'secret' })).toThrow();
		expect(() => connectionOptions(cluster, {})).toThrow();
	});
	it('maps nodes and VMs, excluding templates', async () => {
		const { connection } = fixture();
		expect(await connection.listNodes()).toMatchObject([{ id: 'pve', status: 'online', memoryMB: 4096, memoryUsedMB: 1 }]);
		expect(await connection.listVms('pve')).toEqual([{ id: '100', name: 'test', state: 'running', cpus: undefined, memoryMB: 2048, uptimeSeconds: undefined, consoles: ['vnc'] }]);
	});
	it('offers the terminal of a QEMU VM only without a display and with a serial socket', async () => {
		const { connection, config } = fixture();
		config.get.mockResolvedValueOnce({ name: 'test', memory: 2048, cores: 2, onboot: 1, serial1: 'socket' });
		expect((await connection.listVms('pve'))[0].consoles).toEqual(['vnc']);
		config.get.mockResolvedValueOnce({ name: 'test', vga: 'serial1', serial1: 'socket' });
		expect((await connection.listVms('pve'))[0].consoles).toEqual(['serial']);
		config.get.mockResolvedValueOnce({ name: 'test', vga: 'serial1' });
		expect((await connection.listVms('pve'))[0].consoles).toEqual([]);
		config.get.mockRejectedValueOnce(new Error('No config permission'));
		expect((await connection.listVms('pve'))[0].consoles).toEqual(['vnc']);
	});
	it('lists containers on nodes without QEMU VMs and routes their actions to LXC', async () => {
		const { connection, client, lxc, status, config } = fixture();
		client.api.nodes.get().qemu.list.mockResolvedValueOnce([]);
		lxc.list.mockResolvedValue([{ vmid: 200, name: 'management', status: 'running', maxmem: 1073741824 }]);
		expect(await connection.listVms('management-0')).toMatchObject([{ id: '200', name: 'management', consoles: ['serial'], description: 'LXC container', memoryMB: 1024 }]);
		await connection.power('management-0', '200', 'start');
		expect(lxc.id).toHaveBeenCalledWith(200);
		expect(status.start).toHaveBeenCalledOnce();
		await connection.updateVm('management-0', '200', { name: 'new-host', cores: 2, memory: 2048 });
		expect(config.update).toHaveBeenCalledWith({ $body: expect.objectContaining({ hostname: 'new-host' }) });
		await expect(connection.power('management-0', '200', 'reset')).rejects.toThrow('hardware reset');
	});
	it('waits for power tasks and reports task failures', async () => {
		const { connection, request, status } = fixture();
		await connection.power('pve', '100', 'start');
		expect(status.start).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith('/nodes/{node}/tasks/{upid}/status', 'GET', { $path: { node: 'pve', upid: 'UPID:test' } }, expect.anything());
		request.mockResolvedValueOnce({ status: 'stopped', exitstatus: 'permission denied' });
		await expect(connection.power('pve', '100', 'start')).rejects.toThrow('permission denied');
	});
	it('rejects disk-preserving deletion before making a request', async () => {
		const { connection, request } = fixture();
		await expect(connection.deleteVm('pve', '100', { deleteDisks: false })).rejects.toThrow('owned disks');
		expect(request).not.toHaveBeenCalled();
		request.mockResolvedValueOnce('UPID:delete');
		await connection.deleteVm('pve', '100', { deleteDisks: true });
		expect(request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}', 'DELETE', { $path: { node: 'pve', vmid: 100 } });
	});
	it('creates a VM using node storage and waits for completion', async () => {
		const { connection, request } = fixture();
		request.mockResolvedValueOnce('UPID:create');
		await connection.createVm('pve', { name: 'test', cores: 2, memory: 2048, storage: 'local-lvm', diskGB: 32, bridge: 'vmbr0' });
		expect(request).toHaveBeenCalledWith('/nodes/{node}/qemu', 'POST', { $path: { node: 'pve' }, $body: expect.objectContaining({ vmid: 100, scsi0: 'local-lvm:32', net0: 'virtio,bridge=vmbr0' }) });
	});
	it('converts metrics and releases resources', async () => {
		const { connection, client } = fixture();
		expect(await connection.getVmStats('pve', '100')).toMatchObject({ uptimeSeconds: 123, diskIo: { readBytes: 1000, writeBytes: 2000 }, diskUsage: { usedBytes: 3000, capacityBytes: 4000 }, cpuUsage: 0.2, memoryMB: 2048, memoryUsedMB: 1, network: { rxBytes: 12, txBytes: 34 } });
		connection.dispose();
		expect(client.events.stopListening).toHaveBeenCalledOnce();
	});
	it('shares cluster resource samples and falls back when per-guest stats are unavailable', async () => {
		const { connection, client, status } = fixture();
		status.current.mockRejectedValue(new Error('Status endpoint unavailable'));
		client.api.cluster.resources.index.mockResolvedValue([{ node: 'pve', vmid: 100, cpu: 0.3, diskread: 50, diskwrite: 70, netin: 90, netout: 110 }]);
		expect(await connection.getVmStats('pve', '100')).toMatchObject({ cpuUsage: 0.3, diskIo: { readBytes: 50, writeBytes: 70 }, network: { rxBytes: 90, txBytes: 110 } });
		await connection.getVmStats('pve', '100');
		expect(client.api.cluster.resources.index).toHaveBeenCalledOnce();
	});
	it('opens the web console viewer for a VM and for a container', async () => {
		const { connection, open, lxc } = fixture();
		lxc.list.mockResolvedValue([{ vmid: 105, name: 'ct', status: 'running' }]);
		await connection.listVms('pve');
		await connection.openExternal('pve', '101');
		await connection.openExternal('pve', '105');
		expect(open).toHaveBeenNthCalledWith(1, 'https://pve.test:8006/#v1:0:=qemu%2F101:4:::::8:=consolejs:');
		expect(open).toHaveBeenNthCalledWith(2, 'https://pve.test:8006/#v1:0:=lxc%2F105:4:::::8:=consolejs:');
	});
});
