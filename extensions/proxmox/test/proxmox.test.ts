import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'pve-client';
import { connectionOptions, hasDisplay, macAddresses, ProxmoxConnection, proxmoxConsoles } from '../src/ProxmoxProvider';

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

describe('Proxmox snapshots, clone and templates', () => {
	it('declares the capabilities', () => {
		expect(fixture().connection.capabilities).toMatchObject({ snapshots: true, clone: true, templates: true });
	});
	it('lists snapshots oldest first without the current pseudo snapshot', async () => {
		const { connection, request } = fixture();
		request.mockResolvedValueOnce([{ name: 'b', snaptime: 200, vmstate: 1 }, { name: 'current' }, { name: 'a', snaptime: 100 }]);
		expect(await connection.listSnapshots('pve', '100')).toEqual([{ id: 'a', name: 'a', createdAt: 100_000, includesMemory: false }, { id: 'b', name: 'b', createdAt: 200_000, includesMemory: true }]);
		expect(request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/snapshot', 'GET', { $path: { node: 'pve', vmid: 100 } });
	});
	it('creates, reverts and deletes through the task queue', async () => {
		const { connection, request } = fixture();
		request.mockResolvedValueOnce('UPID:snap').mockResolvedValueOnce({ status: 'stopped', exitstatus: 'OK' }).mockResolvedValueOnce([{ name: 'before', snaptime: 5 }]);
		expect(await connection.createSnapshot('pve', '100', 'before')).toMatchObject({ id: 'before', createdAt: 5000 });
		expect(request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/snapshot', 'POST', { $path: { node: 'pve', vmid: 100 }, $body: { snapname: 'before' } });
		request.mockClear();
		request.mockResolvedValueOnce('UPID:rb');
		await connection.revertSnapshot('pve', '100', 'before');
		expect(request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/snapshot/{snapname}/rollback', 'POST', { $path: { node: 'pve', vmid: 100, snapname: 'before' } });
		request.mockClear();
		request.mockResolvedValueOnce('UPID:del');
		await connection.deleteSnapshot('pve', '100', 'before');
		expect(request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/snapshot/{snapname}', 'DELETE', { $path: { node: 'pve', vmid: 100, snapname: 'before' } });
	});
	it('rejects names Proxmox would refuse, before calling it', async () => {
		const { connection, request } = fixture();
		for (const name of ['1abc', 'a b', 'a', 'x'.repeat(41), 'a/b']) await expect(connection.createSnapshot('pve', '100', name)).rejects.toThrow(/snapshot name/);
		expect(request).not.toHaveBeenCalled();
	});
	it('clones as a full copy under a new id', async () => {
		const { connection, request, client } = fixture();
		client.api.cluster.nextid.mockResolvedValue('102');
		request.mockResolvedValueOnce('UPID:clone').mockResolvedValueOnce({ status: 'stopped', exitstatus: 'OK' });
		const qemu = client.api.nodes.get().qemu;
		qemu.list.mockResolvedValue([{ vmid: 102, name: 'copy', status: 'stopped' }]);
		expect(await connection.cloneVm('pve', '100', 'copy')).toMatchObject({ id: '102', name: 'copy' });
		expect(request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/clone', 'POST', { $path: { node: 'pve', vmid: 100 }, $body: { newid: 102, full: 1, name: 'copy' } });
		await expect(connection.cloneVm('pve', '100', 'bad name')).rejects.toThrow(/machine name/);
	});
	it('converts to a template, but not back', async () => {
		const { connection, request } = fixture();
		request.mockResolvedValueOnce('UPID:tpl');
		await connection.setTemplate('pve', '100', true);
		expect(request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/template', 'POST', { $path: { node: 'pve', vmid: 100 }, $body: {} });
		await expect(connection.setTemplate('pve', '100', false)).rejects.toThrow(/back into a VM/);
	});
});

describe('Proxmox provider', () => {
	it('validates HTTPS origins and API credentials', () => {
		expect(connectionOptions(cluster, { tokenSecret: 'secret' })).toMatchObject({ verifyTls: true, apiToken: 'user@pve!vscode=secret' });
		expect(connectionOptions({ ...cluster, config: { ...cluster.config, verifyTls: false } }, { tokenSecret: 'secret' }).verifyTls).toBe(false);
		for (const endpoint of ['http://pve.test', 'https://user:pass@pve.test', 'https://pve.test/api2/json', 'invalid']) expect(() => connectionOptions({ ...cluster, config: { ...cluster.config, endpoint } }, { tokenSecret: 'secret' })).toThrow();
		expect(() => connectionOptions(cluster, {})).toThrow();
	});
	it('maps nodes and VMs, marking templates', async () => {
		const { connection } = fixture();
		expect(await connection.listNodes()).toMatchObject([{ id: 'pve', status: 'online', memoryMB: 4096, memoryUsedMB: 1 }]);
		expect(await connection.listVms('pve')).toEqual([{ id: '100', displayId: '100', name: 'test', state: 'running', cpus: undefined, memoryMB: 2048, uptimeSeconds: undefined, consoles: ['vnc'] }, { id: '101', displayId: '101', name: 'Guest 101', state: 'unknown', template: true, cpus: undefined, memoryMB: undefined, uptimeSeconds: undefined, consoles: ['vnc'] }]);
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
	it('opens the stand-alone console page for a VM, a display-less VM and a container', async () => {
		const { connection, open, lxc, config } = fixture();
		lxc.list.mockResolvedValue([{ vmid: 105, name: 'ct', status: 'running' }]);
		await connection.listVms('pve');
		await connection.openExternal('pve', '101');
		config.get.mockResolvedValueOnce({ vga: 'serial0', serial0: 'socket' });
		await connection.openExternal('pve', '102');
		await connection.openExternal('pve', '105');
		expect(open).toHaveBeenNthCalledWith(1, 'https://pve.test:8006/?console=kvm&novnc=1&vmid=101&node=pve&resize=off&cmd=');
		expect(open).toHaveBeenNthCalledWith(2, 'https://pve.test:8006/?console=kvm&xtermjs=1&vmid=102&node=pve&cmd=');
		expect(open).toHaveBeenNthCalledWith(3, 'https://pve.test:8006/?console=lxc&xtermjs=1&vmid=105&node=pve&cmd=');
	});
	it('reads MAC addresses from VM and container network config', () => {
		expect(macAddresses({ net0: 'virtio=bc:24:11:aa:bb:cc,bridge=vmbr0', net1: 'e1000=BC:24:11:00:00:01,bridge=vmbr1', name: 'x' })).toEqual(['BC:24:11:AA:BB:CC', 'BC:24:11:00:00:01']);
		expect(macAddresses({ net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:12:34:56,ip=dhcp' })).toEqual(['BC:24:11:12:34:56']);
		expect(macAddresses({ net0: 'virtio,bridge=vmbr0' })).toEqual([]);
		expect(macAddresses(undefined)).toEqual([]);
	});
	it('offers sign-out only for a session, and forgets it when asked', async () => {
		const { client } = fixture();
		const forget = vi.fn().mockResolvedValue(undefined);
		const withSession = new ProxmoxConnection(client as unknown as Client, 'https://pve.test:8006', vi.fn(), () => {}, true, forget);
		expect(withSession.capabilities.signOut).toBe(true);
		await withSession.signOut();
		expect(forget).toHaveBeenCalledOnce();
		expect(fixture().connection.capabilities.signOut).toBeUndefined();
	});
});
