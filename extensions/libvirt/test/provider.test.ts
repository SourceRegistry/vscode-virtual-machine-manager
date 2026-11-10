import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ClusterConfig, ProviderContext } from '@vmm/sdk';
import { LibvirtProvider } from '../src/LibvirtProvider';
import type { Runner } from '../src/virsh';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const XML = fixture('dumpxml.xml');
const UUID = /<uuid>([^<]+)<\/uuid>/.exec(XML)![1]!;
const context = { log: { info() {}, warn() {}, error() {}, debug() {} }, storagePath: '/tmp' } as unknown as ProviderContext;
const cluster = (config: Record<string, unknown> = {}): ClusterConfig => ({ id: 'c', name: 'c', providerId: 'libvirt', config: { connection: 'session', shutdownTimeout: 5, ...config } as ClusterConfig['config'] });

/** A virsh that answers from a table keyed by the command; every call is recorded. */
function fakeVirsh(answers: Record<string, string | Error> = {}) {
	const calls: string[][] = [];
	const run: Runner = async (_file, args) => {
		const command = args.slice(2);
		calls.push(command);
		const key = command[0]!;
		const answer = answers[command.join(' ')] ?? answers[key];
		if (answer instanceof Error) throw Object.assign(answer, { stderr: answer.message });
		if (answer !== undefined) return { stdout: answer, stderr: '' };
		switch (key) {
			case 'version': return { stdout: fixture('version.txt'), stderr: '' };
			case 'nodeinfo': return { stdout: 'CPU model: aarch64\nCPU(s): 8\nMemory size: 16777216 KiB\n', stderr: '' };
			case 'hostname': return { stdout: 'mac\n', stderr: '' };
			case 'domstats': return { stdout: command.includes('--list-active') ? fixture('domstats.txt').replace('state.state=1', 'state.state=5').replace('state.reason=1', 'state.reason=1') : fixture('domstats.txt'), stderr: '' };
			case 'dumpxml': return { stdout: XML, stderr: '' };
			case 'domstate': return { stdout: 'shut off\n', stderr: '' };
			default: return { stdout: '', stderr: '' };
		}
	};
	return { run, calls };
}
const connect = async (answers?: Record<string, string | Error>, config?: Record<string, unknown>) => {
	const fake = fakeVirsh(answers);
	const connection = await new LibvirtProvider(fake.run, () => '/usr/bin/virsh').connect(cluster(config), {}, context);
	return { connection, ...fake };
};

describe('LibvirtProvider', () => {
	it('connects, and fails clearly without virsh', async () => {
		await expect(new LibvirtProvider(fakeVirsh().run, () => undefined).connect(cluster(), {}, context)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('virsh was not found') });
		const { connection, calls } = await connect();
		expect(calls.map((c) => c[0]).sort()).toEqual(['hostname', 'nodeinfo', 'version']);
		expect(await connection.listNodes()).toMatchObject([{ id: 'host', name: 'mac', status: 'online', cpus: 8, memoryMB: 16384 }]);
	});
	it('passes the URI built from the form, and turns a refused login into a permission error', async () => {
		const seen: string[][] = [];
		const run: Runner = async (_f, args) => { seen.push(args); throw Object.assign(new Error('x'), { stderr: 'error: authentication failed: access denied' }); };
		await expect(new LibvirtProvider(run, () => '/v').connect(cluster({ connection: 'ssh', sshHost: 'lab', sshUser: 'me' }), {}, context)).rejects.toMatchObject({ code: 'permission' });
		expect(seen[0]!.slice(0, 2)).toEqual(['-c', 'qemu+ssh://me@lab/system?no_tty=1']);
	});
	it('lists domains by uuid with consoles and media', async () => {
		const { connection } = await connect();
		const [vm] = await connection.listVms('host');
		expect(vm).toMatchObject({ id: UUID, name: 'lvprobe', state: 'stopped', cpus: 2, memoryMB: 1024, os: 'aarch64', consoles: ['vnc', 'serial'], mediaInserted: false });
	});
	it('refuses ids that are not uuids before running anything', async () => {
		const { connection, calls } = await connect();
		const before = calls.length;
		for (const id of ['--help', 'name', '../x', `${UUID} --force`]) await expect(connection.power('host', id, 'stop')).rejects.toMatchObject({ code: 'invalid' });
		expect(calls.length).toBe(before);
	});
	it('maps the power actions', async () => {
		const { connection, calls } = await connect();
		for (const [action, command] of [['start', 'start'], ['stop', 'destroy'], ['reset', 'reset'], ['reboot', 'reboot']] as const) {
			calls.length = 0;
			await connection.power('host', UUID, action);
			expect(calls).toEqual([[command, UUID]]);
		}
	});
	it('reports a graceful shut down that never finishes as a timeout', async () => {
		const { connection } = await connect({ domstate: 'running\n' }, { shutdownTimeout: 5 });
		const started = Date.now();
		await expect(connection.power('host', UUID, 'shutdown')).rejects.toMatchObject({ code: 'timeout' });
		expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
	}, 15_000);
	it('returns once the domain is off after a shut down', async () => {
		const { connection } = await connect({ domstate: 'shut off\n' });
		await expect(connection.power('host', UUID, 'shutdown')).resolves.toBeUndefined();
	});
	it('validates snapshot names and media targets', async () => {
		const { connection, calls } = await connect();
		const before = calls.length;
		for (const name of ['', '-x', 'a b', 'a'.repeat(65), 'a;b']) await expect(connection.createSnapshot('host', UUID, name)).rejects.toMatchObject({ code: 'invalid' });
		await expect(connection.insertMedia('host', UUID, 'sda; rm', '/x.iso')).rejects.toMatchObject({ code: 'invalid' });
		await expect(connection.insertMedia('host', UUID, 'sda', '-x.iso')).rejects.toMatchObject({ code: 'invalid' });
		expect(calls.length).toBe(before);
	});
	it('explains why a UEFI domain cannot be snapshotted', async () => {
		const { connection } = await connect({ 'snapshot-create-as': new Error('error: Operation not supported: internal snapshots of a VM with pflash based firmware require QCOW2 nvram format') });
		await expect(connection.createSnapshot('host', UUID, 'a')).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('UEFI') });
	});
	it('lists snapshots oldest first', async () => {
		const { connection } = await connect({
			'snapshot-list': 'b\na\n',
			'snapshot-dumpxml': '<domainsnapshot><name>x</name><state>shutoff</state><creationTime>5</creationTime></domainsnapshot>'
		});
		expect((await connection.listSnapshots('host', UUID)).map((s) => s.createdAt)).toEqual([5000, 5000]);
	});
	it('will not delete files it cannot reach on a remote host', async () => {
		const { connection, calls } = await connect({ 'vol-info': new Error('error: failed to get vol') }, { connection: 'ssh', sshHost: 'lab' });
		await expect(connection.deleteVm('host', UUID, { deleteDisks: true })).rejects.toMatchObject({ code: 'unsupported' });
		expect(calls.some((c) => c[0] === 'undefine')).toBe(false);
	});
	it('refuses what it cannot do yet', async () => {
		const { connection } = await connect();
		await expect(connection.createVm()).rejects.toMatchObject({ code: 'unsupported' });
		expect(connection.capabilities).toMatchObject({ create: false, snapshots: true, media: true, details: true, stats: true });
	});
	it('says so when the display port refuses the connection', async () => {
		const { connection } = await connect({ domstate: 'running\n', dumpxml: XML.replace("<graphics type='vnc'", "<graphics type='vnc' port='1' ") });
		await expect(connection.openConsole('host', UUID, 'vnc')).rejects.toMatchObject({ code: 'unavailable' });
	});
});
