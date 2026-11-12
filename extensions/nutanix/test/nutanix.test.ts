import { describe, expect, it, vi } from 'vitest';
import { connectionOptions, createSpec, imageOptions, NutanixConnection, NutanixProvider, subnetOptions } from '../src/NutanixProvider';
import { PE, VM1, VM2, clusters, done, hosts, list, prism, vm } from './fake';

const cluster = (config: Record<string, unknown> = {}) => ({ id: 'c1', name: 'Nutanix', providerId: 'nutanix', config: { endpoint: 'https://pc.test:9440', username: 'admin', ...config } as Record<string, string | boolean> });

function connection(routes: Record<string, unknown>) {
	const fake = prism({ 'POST /clusters/list': list(clusters), 'POST /hosts/list': list(hosts), ...routes });
	const open = vi.fn();
	return { ...fake, open, connection: new NutanixConnection(fake.client, true, open) };
}

describe('Nutanix connection settings', () => {
	it('accepts an HTTPS origin and a user name', () => {
		expect(connectionOptions(cluster(), {})).toEqual({ baseUrl: 'https://pc.test:9440', method: 'password', username: 'admin', verifyTls: true, savedPassword: undefined });
		expect(connectionOptions(cluster({ authMethod: 'apiKey', username: '' }), { apiKey: ' k3y ' })).toEqual({ baseUrl: 'https://pc.test:9440', method: 'apiKey', apiKey: 'k3y', verifyTls: true });
		expect(() => connectionOptions(cluster({ authMethod: 'apiKey' }), {})).toThrow(/API key/);
		expect(connectionOptions(cluster({ rememberPassword: true, verifyTls: false }), { password: 'pw' })).toMatchObject({ verifyTls: false, savedPassword: 'pw' });
	});
	it('ignores a saved password unless remembering is on', () => {
		expect(connectionOptions(cluster(), { password: 'pw' })).toMatchObject({ savedPassword: undefined });
	});
	it('rejects what basic auth or the URL cannot carry', () => {
		for (const endpoint of ['http://pc.test:9440', 'https://pc.test:9440/api', 'https://u:p@pc.test', 'nope']) expect(() => connectionOptions(cluster({ endpoint }), {})).toThrow(/HTTPS/);
		for (const username of ['', 'a:b', 'a b']) expect(() => connectionOptions(cluster({ username }), {})).toThrow(/user name/);
	});
});

describe('Nutanix sign-in', () => {
	function provider(answer: string | undefined) {
		const host = { prompt: vi.fn().mockResolvedValue(answer), openUrl: vi.fn() };
		return { host, provider: new NutanixProvider(host) };
	}
	it('never prompts when the extension connects by itself', async () => {
		const { host, provider: p } = provider('pw');
		await expect(p.connect(cluster(), {}, { storagePath: '', log: console as never, interactive: false })).rejects.toMatchObject({ code: 'authRequired' });
		expect(host.prompt).not.toHaveBeenCalled();
	});
	it('cancels when no password is entered', async () => {
		const { provider: p } = provider(undefined);
		await expect(p.connect(cluster(), {})).rejects.toThrow('Sign-in cancelled.');
	});
	it('offers sign-out only for a password that is not saved', async () => {
		const plain = new NutanixConnection(prism({}).client, true, vi.fn(), () => {}, async () => {});
		const saved = new NutanixConnection(prism({}).client, true, vi.fn());
		expect(plain.capabilities.signOut).toBe(true);
		expect(saved.capabilities.signOut).toBeUndefined();
	});
});

describe('Nutanix inventory', () => {
	it('lists the Prism Element clusters as nodes, without Prism Central', async () => {
		const { connection: c } = connection({});
		const nodes = await c.listNodes();
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ id: PE, name: 'ahv-01', status: 'online', cpus: 64, memoryMB: 524288 });
		expect(nodes[0]!.facts).toEqual([{ label: 'AOS', value: '6.10' }, { label: 'Hypervisor', value: 'AHV 20230302' }, { label: 'Hosts', value: '2' }, { label: 'Address', value: '10.0.0.10' }]);
	});
	it('lists the VMs of one cluster from one shared listing', async () => {
		const { connection: c, calls } = connection({ 'POST /vms/list': list([vm(VM1), vm(VM2, { name: 'db', power: 'OFF', cluster: 'other' })]) });
		const vms = await c.listVms(PE);
		expect(vms).toEqual([{ id: VM1, name: 'web', state: 'running', cpus: 4, memoryMB: 4096, ipAddresses: ['10.0.0.5'], macAddresses: ['50:6B:8D:AA:BB:CC'], consoles: ['vnc'] }]);
		expect(await c.listVms('other')).toMatchObject([{ id: VM2, state: 'stopped' }]);
		expect(calls.filter((x) => x.path === '/vms/list')).toHaveLength(1);
	});
	it('shows a VM on its way to the wanted power state while Prism applies it', async () => {
		const { connection: c } = connection({ 'POST /vms/list': list([vm(VM1, { power: 'OFF', wanted: 'ON', state: 'RUNNING' }), vm(VM2, { power: 'ON', wanted: 'OFF', state: 'PENDING' })]) });
		expect((await c.listVms(PE)).map((v) => v.state)).toEqual(['starting', 'stopping']);
	});
	it('reports disks, the CD-ROM and NICs', async () => {
		const { connection: c } = connection({ [`GET /vms/${VM1}`]: vm(VM1, { resources: { gpu_list: [{ vendor: 'NVIDIA', mode: 'PASSTHROUGH_GRAPHICS', pci_address: '0000:3b:00.0' }] } }) });
		const details = await c.getVmDetails(PE, VM1);
		expect(details.disks).toEqual([
			{ id: 'd1', kind: 'disk', label: 'SCSI 0', path: 'default', sizeBytes: 34359738368, bus: 'scsi' },
			{ id: 'd2', kind: 'cdrom', label: 'IDE 0', path: undefined, sizeBytes: undefined, bus: 'ide', removable: true }
		]);
		expect(details.nics).toEqual([{ id: 'nic-1', label: 'NIC 1', model: 'virtio', mac: '50:6B:8D:AA:BB:CC', network: 'vlan0', ipAddresses: ['10.0.0.5'], connected: true }]);
		expect(details.devices).toEqual([{ id: 'gpu0', kind: 'pci', label: 'Nvidia GPU', address: '0000:3b:00.0', description: 'passthrough graphics' }]);
	});
	it('turns the usage ratios of /groups into a stats sample', async () => {
		const { connection: c, calls } = connection({
			[`GET /vms/${VM1}`]: vm(VM1),
			'POST /groups': { group_results: [{ entity_results: [{ entity_id: VM1, data: [{ name: 'hypervisor_cpu_usage_ppm', values: [{ values: ['250000'] }] }, { name: 'memory_usage_ppm', values: [{ values: ['500000'] }] }, { name: 'hypervisor_memory_usage_ppm', values: [] }] }] }] }
		});
		expect(await c.getVmStats(PE, VM1)).toMatchObject({ cpuUsage: 0.25, memoryMB: 4096, memoryUsedMB: 2048, memorySource: 'guest' });
		expect(calls.find((x) => x.path === '/groups')!.body).toMatchObject({ entity_type: 'mh_vm', entity_ids: [VM1] });
	});
	it('still samples the memory size when /groups is not allowed', async () => {
		const { connection: c } = connection({ [`GET /vms/${VM1}`]: vm(VM1), 'POST /groups': new Response('{}', { status: 403 }) });
		const stats = await c.getVmStats(PE, VM1);
		expect(stats).toMatchObject({ memoryMB: 4096 });
		expect(stats.cpuUsage).toBeUndefined();
	});
	it('rejects ids that are not UUIDs before calling Prism', async () => {
		const { connection: c, fetch } = connection({});
		await expect(c.getVmDetails(PE, '../clusters')).rejects.toMatchObject({ code: 'invalid' });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('Nutanix create and edit', () => {
	const subnets = [
		{ metadata: { uuid: 'a0000000-0000-4000-8000-000000000001' }, status: { name: 'vlan10', cluster_reference: { uuid: PE }, resources: { subnet_type: 'VLAN', vlan_id: 10 } } },
		{ metadata: { uuid: 'a0000000-0000-4000-8000-000000000002' }, status: { name: 'elsewhere', cluster_reference: { uuid: 'other' }, resources: { subnet_type: 'VLAN', vlan_id: 20 } } },
		{ metadata: { uuid: 'a0000000-0000-4000-8000-000000000003' }, status: { name: 'vpc-a', resources: { subnet_type: 'OVERLAY' } } }
	];
	const images = [
		{ metadata: { uuid: 'b0000000-0000-4000-8000-000000000001' }, status: { name: 'debian-13', state: 'COMPLETE', resources: { image_type: 'DISK_IMAGE', size_bytes: 3 * 1024 ** 3, current_cluster_reference_list: [{ uuid: PE }] } } },
		{ metadata: { uuid: 'b0000000-0000-4000-8000-000000000002' }, status: { name: 'ubuntu.iso', state: 'COMPLETE', resources: { image_type: 'ISO_IMAGE' } } },
		{ metadata: { uuid: 'b0000000-0000-4000-8000-000000000003' }, status: { name: 'other-cluster', state: 'COMPLETE', resources: { image_type: 'DISK_IMAGE', current_cluster_reference_list: [{ uuid: 'other' }] } } }
	];
	it('offers the subnets and images usable on the cluster', () => {
		expect(subnetOptions(subnets, PE).map((s) => [s.label, s.description])).toEqual([['vlan10', 'VLAN 10'], ['vpc-a', 'VPC subnet']]);
		expect(imageOptions(images, PE, 'DISK_IMAGE').map((i) => i.label)).toEqual(['debian-13']);
		expect(imageOptions(images, PE, 'ISO_IMAGE').map((i) => i.label)).toEqual(['ubuntu.iso']);
	});
	it('builds a VM from an image, grown to the disk size, with cloud-init', () => {
		const spec = createSpec(PE, { name: 'dev', sockets: 2, coresPerSocket: 1, memory: 2048, subnet: 's', image: 'img', diskGB: 20, iso: '', cloudInit: '#cloud-config\n', start: true }, 3 * 1024 ** 3);
		expect(spec.spec.cluster_reference).toEqual({ kind: 'cluster', uuid: PE });
		expect(spec.spec.resources).toMatchObject({ num_sockets: 2, num_vcpus_per_socket: 1, memory_size_mib: 2048, power_state: 'ON', nic_list: [{ subnet_reference: { kind: 'subnet', uuid: 's' }, is_connected: true }], boot_config: { boot_device_order_list: ['DISK', 'CDROM', 'NETWORK'] } });
		expect(spec.spec.resources.disk_list[0]).toEqual({ device_properties: { device_type: 'DISK', disk_address: { adapter_type: 'SCSI', device_index: 0 } }, data_source_reference: { kind: 'image', uuid: 'img' }, disk_size_mib: 20480 });
		expect(spec.spec.resources.disk_list[1]).toEqual({ device_properties: { device_type: 'CDROM', disk_address: { adapter_type: 'IDE', device_index: 0 } } });
		expect(Buffer.from(spec.spec.resources.guest_customization!.cloud_init.user_data, 'base64').toString()).toBe('#cloud-config');
	});
	it('keeps an image disk at the image size when the asked size is smaller, and boots an installer ISO first', () => {
		const fromImage = createSpec(PE, { name: 'a', sockets: 1, memory: 1024, image: 'img', diskGB: 1 }, 3 * 1024 ** 3);
		expect(fromImage.spec.resources.disk_list[0]).not.toHaveProperty('disk_size_mib');
		const installer = createSpec(PE, { name: 'b', sockets: 1, memory: 1024, diskGB: 40, iso: 'iso' });
		expect(installer.spec.resources.disk_list).toEqual([
			{ device_properties: { device_type: 'DISK', disk_address: { adapter_type: 'SCSI', device_index: 0 } }, disk_size_mib: 40960 },
			{ device_properties: { device_type: 'CDROM', disk_address: { adapter_type: 'IDE', device_index: 0 } }, data_source_reference: { kind: 'image', uuid: 'iso' } }
		]);
		expect(installer.spec.resources.boot_config.boot_device_order_list[0]).toBe('CDROM');
		expect(installer.spec.resources.nic_list).toEqual([]);
		expect(installer.spec.resources.power_state).toBe('OFF');
	});
	it('creates through a task and returns the new VM', async () => {
		const { connection: c, calls } = connection({
			'POST /subnets/list': list(subnets), 'POST /images/list': list(images),
			'GET /images/b0000000-0000-4000-8000-000000000001': images[0],
			'POST /vms': { metadata: { uuid: VM2 }, status: { state: 'PENDING', execution_context: { task_uuid: 'task-1' } } },
			'GET /tasks/task-1': done(),
			[`GET /vms/${VM2}`]: vm(VM2, { name: 'dev', power: 'OFF' })
		});
		const progress = vi.fn();
		const created = await c.createVm(PE, { name: 'dev', sockets: 2, coresPerSocket: 1, memory: 2048, subnet: subnets[0]!.metadata.uuid, image: images[0]!.metadata.uuid, diskGB: 32, iso: '', start: false }, progress);
		expect(created).toMatchObject({ id: VM2, name: 'dev', state: 'stopped' });
		expect(calls.find((x) => x.method === 'POST' && x.path === '/vms')!.body.spec.resources.disk_list[0].disk_size_mib).toBe(32768);
		expect(progress).toHaveBeenCalled();
	});
	it('edits by sending the spec back with its metadata, never the status', async () => {
		const { connection: c, calls } = connection({ [`GET /vms/${VM1}`]: vm(VM1), [`PUT /vms/${VM1}`]: { status: { execution_context: { task_uuid: 't' } } }, 'GET /tasks/t': done() });
		expect(await c.getVmConfig(PE, VM1)).toMatchObject({ values: { name: 'web', sockets: 2, coresPerSocket: 2, memory: 4096 } });
		await c.updateVm(PE, VM1, { name: 'web-2', sockets: 4, coresPerSocket: 1, memory: 8192, description: 'hello' });
		const put = calls.find((x) => x.method === 'PUT')!.body;
		expect(put).not.toHaveProperty('status');
		expect(put.metadata).toMatchObject({ uuid: VM1, spec_version: 3 });
		expect(put.spec).toMatchObject({ name: 'web-2', description: 'hello', resources: { num_sockets: 4, num_vcpus_per_socket: 1, memory_size_mib: 8192 } });
	});
	it('refuses to delete without deleting the disks', async () => {
		const { connection: c, fetch } = connection({});
		await expect(c.deleteVm(PE, VM1, { deleteDisks: false })).rejects.toMatchObject({ code: 'unsupported' });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('Nutanix power', () => {
	const routes = {
		[`GET /vms/${VM1}`]: vm(VM1, { power: 'OFF' }),
		[`PUT /vms/${VM1}`]: { status: { execution_context: { task_uuid: 't' } } },
		[`POST /vms/${VM1}/acpi_reboot`]: { task_uuid: 't' },
		[`POST /vms/${VM1}/reset`]: { task_uuid: 't' },
		[`POST /vms/${VM1}/acpi_shutdown`]: { task_uuid: 't' },
		'GET /tasks/t': done()
	};
	it('starts and powers off through the spec', async () => {
		const { connection: c, calls } = connection(routes);
		await c.power(PE, VM1, 'start');
		expect(calls.find((x) => x.method === 'PUT')!.body.spec.resources).toMatchObject({ power_state: 'ON' });
		calls.length = 0;
		await c.power(PE, VM1, 'stop');
		expect(calls.find((x) => x.method === 'PUT')!.body.spec.resources).toMatchObject({ power_state: 'OFF', power_state_mechanism: { mechanism: 'HARD' } });
	});
	it('shuts down, reboots and resets through the power endpoints', async () => {
		const { connection: c, calls } = connection(routes);
		for (const action of ['shutdown', 'reboot', 'reset'] as const) await c.power(PE, VM1, action);
		expect(calls.filter((x) => x.method === 'POST').map((x) => x.path)).toEqual([`/vms/${VM1}/acpi_shutdown`, `/vms/${VM1}/acpi_reboot`, `/vms/${VM1}/reset`]);
	});
	it('falls back to an ACPI power-off through the spec on a Prism without the endpoint', async () => {
		const { [`POST /vms/${VM1}/acpi_shutdown`]: _, ...older } = routes;
		const { connection: c, calls } = connection(older);
		await c.power(PE, VM1, 'shutdown');
		expect(calls.find((x) => x.method === 'PUT')!.body.spec.resources).toMatchObject({ power_state: 'OFF', power_state_mechanism: { mechanism: 'ACPI' } });
	});
	it('says when the guest has not finished in time', async () => {
		const { connection: c } = connection({ ...routes, 'GET /tasks/t': { status: 'RUNNING' } });
		vi.useFakeTimers();
		try {
			const result = expect(c.power(PE, VM1, 'reboot')).rejects.toMatchObject({ code: 'timeout' });
			await vi.advanceTimersByTimeAsync(130_000);
			await result;
		} finally { vi.useRealTimers(); }
	});
});

describe('Nutanix recovery points and clones', () => {
	const rp = (uuid: string, parent: string, name: string, created: string) => ({ metadata: { uuid }, status: { name, resources: { parent_vm_reference: { kind: 'vm', uuid: parent }, creation_time: created } } });
	const RP1 = 'c0000000-0000-4000-8000-000000000001';
	const RP2 = 'c0000000-0000-4000-8000-000000000002';
	it('lists the recovery points of the VM, oldest first', async () => {
		const { connection: c } = connection({ 'POST /vm_recovery_points/list': list([rp(RP2, VM1, 'after', '2026-11-12T10:00:00Z'), rp('x', VM2, 'other', '2026-11-01T00:00:00Z'), rp(RP1, VM1, 'before', '2026-11-11T10:00:00Z')]) });
		expect(await c.listSnapshots(PE, VM1)).toEqual([
			{ id: RP1, name: 'before', createdAt: Date.parse('2026-11-11T10:00:00Z'), includesMemory: false },
			{ id: RP2, name: 'after', createdAt: Date.parse('2026-11-12T10:00:00Z'), includesMemory: false }
		]);
	});
	it('creates a crash-consistent recovery point and returns it', async () => {
		const { connection: c, calls } = connection({
			[`POST /vms/${VM1}/snapshot`]: { task_uuid: 't' },
			'GET /tasks/t': done({ entity_reference_list: [{ kind: 'vm', uuid: VM1 }, { kind: 'vm_recovery_point', uuid: RP1 }] }),
			'POST /vm_recovery_points/list': list([rp(RP1, VM1, 'before', '2026-11-11T10:00:00Z')])
		});
		expect(await c.createSnapshot(PE, VM1, 'before')).toMatchObject({ id: RP1, name: 'before' });
		expect(calls[0]!.body).toEqual({ name: 'before', recovery_point_type: 'CRASH_CONSISTENT' });
		expect(c.capabilities).toMatchObject({ snapshots: true, snapshotRevertNeedsStopped: true, clone: true });
	});
	it('reverts and deletes through tasks', async () => {
		const { connection: c, calls } = connection({ [`POST /vms/${VM1}/revert`]: { task_uuid: 't' }, [`DELETE /vm_recovery_points/${RP1}`]: { status: { execution_context: { task_uuid: 't' } } }, 'GET /tasks/t': done() });
		await c.revertSnapshot(PE, VM1, RP1);
		await c.deleteSnapshot(PE, VM1, RP1);
		expect(calls.filter((x) => x.method !== 'GET').map((x) => [x.method, x.path, x.body])).toEqual([['POST', `/vms/${VM1}/revert`, { vm_recovery_point_uuid: RP1 }], ['DELETE', `/vm_recovery_points/${RP1}`, undefined]]);
	});
	it('clones under a new name and returns the new VM from the task', async () => {
		const { connection: c, calls } = connection({ [`POST /vms/${VM1}/clone`]: { task_uuid: 't' }, 'GET /tasks/t': done({ entity_reference_list: [{ kind: 'vm', uuid: VM1 }, { kind: 'vm', uuid: VM2 }] }), [`GET /vms/${VM2}`]: vm(VM2, { name: 'copy', power: 'OFF' }) });
		expect(await c.cloneVm(PE, VM1, 'copy')).toMatchObject({ id: VM2, name: 'copy', state: 'stopped' });
		expect(calls[0]!.body).toEqual({ override_spec: { name: 'copy' } });
	});
	it('rejects names Prism would refuse, before calling it', async () => {
		const { connection: c, fetch } = connection({});
		for (const name of ['', ' ', 'x'.repeat(81), 'a\nb']) await expect(c.cloneVm(PE, VM1, name)).rejects.toMatchObject({ code: 'invalid' });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('Nutanix sign-in against a fake Prism', () => {
	const auto = { storagePath: '', log: console as never, interactive: false };
	it('keeps a typed password in memory for the next connect, and forgets it on sign-out or rejection', async () => {
		const host = { prompt: vi.fn().mockResolvedValue('pw'), openUrl: vi.fn() };
		const fake = prism({ 'POST /clusters/list': list(clusters), 'POST /hosts/list': list(hosts) });
		let transport = fake.fetch as unknown as typeof fetch;
		const p = new NutanixProvider(host, () => transport);
		(await p.connect(cluster(), {})).dispose();
		const second = await p.connect(cluster(), {}, auto);
		expect(host.prompt).toHaveBeenCalledTimes(1);
		expect(fake.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('admin:pw').toString('base64')}`);
		await second.signOut();
		second.dispose();
		await expect(p.connect(cluster(), {}, auto)).rejects.toMatchObject({ code: 'authRequired' });
		transport = prism({ 'POST /clusters/list': new Response('{}', { status: 401 }) }).fetch as unknown as typeof fetch;
		await expect(p.connect(cluster(), {})).rejects.toMatchObject({ code: 'permission' });
		await expect(p.connect(cluster(), {}, auto)).rejects.toMatchObject({ code: 'authRequired' });
	});
	it('signs requests with an API key, without prompting or offering sign-out', async () => {
		const host = { prompt: vi.fn(), openUrl: vi.fn() };
		const fake = prism({ 'POST /clusters/list': list(clusters), 'POST /hosts/list': list(hosts) });
		const c = await new NutanixProvider(host, () => fake.fetch as unknown as typeof fetch).connect(cluster({ authMethod: 'apiKey' }), { apiKey: 'k3y' }, auto);
		expect(fake.calls[0]!.headers['x-ntnx-api-key']).toBe('k3y');
		expect(fake.calls[0]!.headers.authorization).toBeUndefined();
		expect(c.capabilities.signOut).toBeUndefined();
		expect(host.prompt).not.toHaveBeenCalled();
	});
	it('names the saved password when Prism rejects it', async () => {
		const host = { prompt: vi.fn(), openUrl: vi.fn() };
		const p = new NutanixProvider(host, () => prism({ 'POST /clusters/list': new Response('{}', { status: 401 }) }).fetch as unknown as typeof fetch);
		await expect(p.connect(cluster({ rememberPassword: true }), { password: 'old' })).rejects.toThrow(/saved password/);
		expect(host.prompt).not.toHaveBeenCalled();
	});
});
