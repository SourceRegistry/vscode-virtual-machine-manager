// The provider end to end over HTTPS against scripts/fake-prism.mjs (the fake used for manual testing).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NutanixProvider, type NutanixConnection } from '../src/NutanixProvider';
// @ts-expect-error plain ESM script without types
import { startFakePrism } from '../scripts/fake-prism.mjs';

type Fake = { url: string; close(): Promise<void>; state: { vms: Array<{ metadata: { uuid: string }; status: { name: string } }> } };

describe('Nutanix provider against the fake Prism', () => {
	let fake: Fake;
	let connection: NutanixConnection;
	let node: string;
	const host = { prompt: async () => 'nutanix/4u', openUrl: async () => undefined };

	beforeAll(async () => {
		fake = await startFakePrism({ port: 0, delay: 20, apiKey: 'test-key', log: undefined });
		const cluster = { id: 'fake', name: 'fake', providerId: 'nutanix', config: { endpoint: fake.url, username: 'admin', verifyTls: false } };
		connection = await new NutanixProvider(host).connect(cluster, {});
		node = (await connection.listNodes())[0]!.id;
	});
	afterAll(async () => { connection?.dispose(); await fake?.close(); });

	it('rejects a wrong password and accepts the API key', async () => {
		const wrong = new NutanixProvider({ ...host, prompt: async () => 'wrong' });
		await expect(wrong.connect({ id: 'w', name: 'w', providerId: 'nutanix', config: { endpoint: fake.url, username: 'admin', verifyTls: false } }, {})).rejects.toMatchObject({ code: 'permission' });
		const keyed = await new NutanixProvider(host).connect({ id: 'k', name: 'k', providerId: 'nutanix', config: { endpoint: fake.url, authMethod: 'apiKey', verifyTls: false } }, { apiKey: 'test-key' });
		expect(await keyed.listNodes()).toHaveLength(1);
		keyed.dispose();
	});

	it('lists the cluster and its VMs', async () => {
		const [cluster] = await connection.listNodes();
		expect(cluster).toMatchObject({ name: 'ce-cluster-1', status: 'online', cpus: 32 });
		const vms = await connection.listVms(node);
		expect(vms.map((v) => [v.name, v.state])).toEqual([['web-01', 'running'], ['db-01', 'running'], ['build-runner', 'stopped'], ['win-test', 'stopped']]);
		expect(vms[0]!.ipAddresses?.[0]).toMatch(/^10\.42\.1\./);
	});

	it('creates from an image, starts, snapshots, clones, reverts and deletes', { timeout: 30_000 }, async () => {
		const schema = await connection.getCreateSchema(node);
		const image = schema.find((f) => f.key === 'image')!.options!.find((o) => o.label.startsWith('debian'))!.value;
		const subnet = schema.find((f) => f.key === 'subnet')!.options![0]!.value;
		const vm = await connection.createVm(node, { name: 'dev-box', sockets: 2, coresPerSocket: 1, memory: 2048, subnet, image, diskGB: 20, iso: '', start: false });
		expect(vm).toMatchObject({ name: 'dev-box', state: 'stopped', cpus: 2, memoryMB: 2048 });
		expect((await connection.getVmDetails(node, vm.id)).disks[0]).toMatchObject({ kind: 'disk', path: 'debian-13-genericcloud-amd64', sizeBytes: 20 * 1024 ** 3 });

		await connection.power(node, vm.id, 'start');
		expect((await connection.listVms(node)).find((v) => v.id === vm.id)!.state).toBe('running');
		expect(await connection.getVmStats(node, vm.id)).toMatchObject({ memoryMB: 2048, memorySource: 'guest' });

		await connection.updateVm(node, vm.id, { name: 'dev-box', sockets: 4, coresPerSocket: 1, memory: 4096, description: 'bigger' });
		expect((await connection.getVmConfig(node, vm.id)).values).toMatchObject({ sockets: 4, memory: 4096, description: 'bigger' });

		const snapshot = await connection.createSnapshot(node, vm.id, 'before upgrade');
		expect(await connection.listSnapshots(node, vm.id)).toEqual([snapshot]);
		const copy = await connection.cloneVm(node, vm.id, 'dev-box-copy');
		expect(copy).toMatchObject({ name: 'dev-box-copy', state: 'stopped' });

		await expect(connection.revertSnapshot(node, vm.id, snapshot.id)).rejects.toThrow(/Power off/);
		await connection.power(node, vm.id, 'shutdown');
		expect((await connection.listVms(node)).find((v) => v.id === vm.id)!.state).toBe('stopped');
		await connection.revertSnapshot(node, vm.id, snapshot.id);
		await connection.deleteSnapshot(node, vm.id, snapshot.id);
		expect(await connection.listSnapshots(node, vm.id)).toEqual([]);

		await connection.deleteVm(node, vm.id, { deleteDisks: true });
		await connection.deleteVm(node, copy.id, { deleteDisks: true });
		expect((await connection.listVms(node)).map((v) => v.name)).not.toContain('dev-box');
	});

	it('reports a guest that ignores ACPI shutdown, and powers it off', { timeout: 15_000 }, async () => {
		const win = (await connection.listVms(node)).find((v) => v.name === 'win-test')!;
		await connection.power(node, win.id, 'start');
		await expect(connection.power(node, win.id, 'shutdown')).rejects.toThrow(/did not respond/);
		await connection.power(node, win.id, 'stop');
		expect((await connection.listVms(node)).find((v) => v.id === win.id)!.state).toBe('stopped');
	});

	it('serves an RFB display through the console proxy', async () => {
		const web = (await connection.listVms(node)).find((v) => v.name === 'web-01')!;
		const console = await connection.openConsole(node, web.id, 'vnc');
		const data: Buffer[] = [];
		console.stream.on('data', (chunk: Buffer) => data.push(chunk));
		await expect.poll(() => Buffer.concat(data).toString('latin1')).toBe('RFB 003.008\n');
		console.stream.write(Buffer.from('RFB 003.008\n'));
		await expect.poll(() => Buffer.concat(data).length).toBe(12 + 2);
		console.stream.write(Buffer.from([1]));
		console.stream.write(Buffer.from([1]));
		await expect.poll(() => Buffer.concat(data).toString('latin1')).toContain('web-01 (fake Prism)');
		const all = Buffer.concat(data);
		expect(all.readUInt16BE(18)).toBe(640);
		console.dispose();
	});
});
