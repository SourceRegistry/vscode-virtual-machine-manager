import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClusterConfig, ProviderContext } from '@vmm/sdk';
import { LibvirtProvider, parseVolumeXml } from '../src/LibvirtProvider';
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
			// A start also reads the saved port forwards (none here) to add them to the running domain.
			expect(calls[0]).toEqual([command, UUID]);
			expect(calls.slice(1).every((c) => c[0] === 'metadata')).toBe(true);
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
	it('creates a domain: a volume in the pool, then the definition', async () => {
		const caps = fixture('domcapabilities.xml');
		const { connection, calls } = await connect({ domcapabilities: caps, 'pool-list --type dir --name': 'default\n', 'net-list --name': '', 'list --all --name': 'other\n', 'vol-path --pool default lvprobe.qcow2': '/pool/lvprobe.qcow2\n' });
		const progress: string[] = [];
		const vm = await connection.createVm('host', { name: 'lvprobe', cpus: 2, memoryMB: 1024, diskGB: 10, iso: '/isos/a.iso', network: 'user', pool: 'default', diskBus: 'virtio' }, (u) => progress.push(u.message ?? ''));
		expect(vm.name).toBe('lvprobe');
		const commands = calls.map((c) => c.join(' '));
		expect(commands).toContain('vol-create-as default lvprobe.qcow2 10G --format qcow2');
		const define = calls.find((c) => c[0] === 'define')!;
		expect(define[1]).toMatch(/domain\.xml$/);
		expect(commands.indexOf('vol-create-as default lvprobe.qcow2 10G --format qcow2')).toBeLessThan(calls.findIndex((c) => c[0] === 'define'));
		expect(progress.length).toBeGreaterThan(0);
	});
	it('asks for the virt machine when the default ARM machine is the toy integratorcp (Debian)', async () => {
		const { connection, calls } = await connect({ domcapabilities: fixture('domcapabilities-debian-default.xml'), 'domcapabilities --machine virt': fixture('domcapabilities-debian-virt.xml'), 'pool-list --type dir --name': 'default\n', 'vol-path --pool default lvprobe.qcow2': '/pool/lvprobe.qcow2\n' });
		await connection.createVm('host', { name: 'lvprobe', cpus: 2, memoryMB: 1024, diskGB: 5, network: 'user', pool: 'default' });
		expect(calls.map((c) => c.join(' '))).toContain('domcapabilities --machine virt');
	});
	it('removes the new disk when the definition fails', async () => {
		const caps = fixture('domcapabilities.xml');
		const { connection, calls } = await connect({ domcapabilities: caps, 'pool-list --type dir --name': 'default\n', 'vol-path --pool default web.qcow2': '/pool/web.qcow2\n', define: new Error('error: boom') });
		await expect(connection.createVm('host', { name: 'web', cpus: 1, memoryMB: 512, diskGB: 5, network: 'user', pool: 'default' })).rejects.toBeTruthy();
		expect(calls.map((c) => c.join(' '))).toContain('vol-delete --pool default web.qcow2');
	});
	it('rejects a bad name, an existing domain and a relative ISO before touching storage', async () => {
		const { connection, calls } = await connect({ 'list --all --name': 'taken\n' });
		const base = { cpus: 1, memoryMB: 512, diskGB: 5, network: 'user' };
		await expect(connection.createVm('host', { ...base, name: '-rf' })).rejects.toMatchObject({ code: 'invalid' });
		await expect(connection.createVm('host', { ...base, name: 'a', iso: 'rel.iso' })).rejects.toMatchObject({ code: 'invalid' });
		await expect(connection.createVm('host', { ...base, name: 'taken' })).rejects.toMatchObject({ code: 'invalid' });
		expect(calls.some((c) => c[0] === 'vol-create-as')).toBe(false);
	});
	it('offers a pool it can create on this computer, and none on another host', async () => {
		const caps = fixture('domcapabilities.xml');
		const local = await connect({ domcapabilities: caps, 'pool-list --type dir --name': '' });
		expect((await local.connection.getCreateSchema()).find((f) => f.key === 'pool')!.options).toHaveLength(1);
		expect(local.connection.capabilities.remotePaths).toBe(false);
		const remote = await connect({ domcapabilities: caps, 'pool-list --type dir --name': '' }, { connection: 'ssh', sshHost: 'lab', scope: 'session' });
		expect((await remote.connection.getCreateSchema()).find((f) => f.key === 'pool')!.options).toHaveLength(0);
		const system = await connect({ domcapabilities: caps, 'pool-list --type dir --name': '' }, { connection: 'ssh', sshHost: 'lab' });
		expect((await system.connection.getCreateSchema()).find((f) => f.key === 'pool')!.options).toMatchObject([{ label: 'New pool in /var/lib/libvirt/images' }]);
		expect(remote.connection.capabilities.remotePaths).toBe(true);
	});
	describe('from a cloud image', () => {
		const scratch = mkdtempSync(join(tmpdir(), 'vmm-libvirt-test-'));
		afterAll(() => rmSync(scratch, { recursive: true, force: true }));
		// A qcow2 header is all the provider reads of the image; the upload itself is virsh's.
		const image = join(scratch, 'my.qcow2');
		writeFileSync(image, Buffer.concat([Buffer.from([0x51, 0x46, 0x49, 0xfb]), Buffer.alloc(1020)]));
		const raw = join(scratch, 'my.raw');
		writeFileSync(raw, Buffer.alloc(2048));
		const caps = fixture('domcapabilities.xml');
		const volXml = (format: string, gb: number) => `<volume><capacity unit='bytes'>${gb * 1024 ** 3}</capacity><target><format type='${format}'/></target></volume>`;
		const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKey me@host';
		const values = { name: 'lvprobe', source: 'cloud', cloudImage: 'custom', cloudImageFile: image, ciUser: 'me', ciSshKey: key, cpus: 2, memoryMB: 1024, diskGB: 10, network: 'user', pool: 'default' };
		const answers = (extra: Record<string, string | Error> = {}) => ({
			domcapabilities: caps, 'pool-list --type dir --name': 'default\n', 'list --all --name': '',
			'vol-dumpxml --pool default lvprobe.qcow2': volXml('qcow2', 3), 'vol-path --pool default lvprobe.qcow2': '/pool/lvprobe.qcow2\n', 'vol-path --pool default lvprobe-cidata.iso': '/pool/lvprobe-cidata.iso\n',
			...extra
		});
		/** Connects with a virsh that also keeps the domain XML handed to `define`. */
		const connectKeepingXml = async (extra?: Record<string, string | Error>) => {
			const fake = fakeVirsh(answers(extra));
			const defined: string[] = [];
			const run: Runner = async (file, args, options) => {
				if (args[2] === 'define') defined.push(readFileSync(args[3]!, 'utf8'));
				return fake.run(file, args, options);
			};
			const connection = await new LibvirtProvider(run, () => '/usr/bin/virsh').connect(cluster(), {}, { ...context, storagePath: scratch });
			return { connection, calls: fake.calls, defined };
		};

		it('offers the cloud fields and hides the ISO for them', async () => {
			const { connection } = await connect({ domcapabilities: caps, 'pool-list --type dir --name': 'default\n' });
			const schema = await connection.getCreateSchema();
			expect(schema.find((f) => f.key === 'source')!.options!.map((o) => o.value)).toEqual(['iso', 'cloud']);
			expect(schema.find((f) => f.key === 'iso')!.showWhen).toMatchObject({ key: 'source', equals: 'iso' });
			// Only images the host can run (the fixture is an ARM host), plus a file.
			const images = schema.find((f) => f.key === 'cloudImage')!.options!.map((o) => o.value);
			expect(images).toContain('debian-13@aarch64');
			expect(images.some((i) => i.endsWith('@x86_64'))).toBe(false);
			expect(images.at(-1)).toBe('custom');
			expect(schema.map((f) => f.key)).toEqual(expect.arrayContaining(['ciUser', 'ciSshKey', 'ciPassword', 'ciAgent', 'ciUserData']));
		});

		it('uploads the image as the disk, enlarges it, adds a cidata seed and defines the domain', async () => {
			const { connection, calls, defined } = await connectKeepingXml();
			const progress: number[] = [];
			const vm = await connection.createVm('host', values, (u) => u.fraction !== undefined && progress.push(u.fraction));
			expect(vm.name).toBe('lvprobe');
			const commands = calls.map((c) => c.join(' '));
			const order = [
				'vol-create-as default lvprobe.qcow2 1024b --format raw',
				`vol-upload --pool default lvprobe.qcow2 ${image}`,
				'pool-refresh default',
				'vol-resize --pool default lvprobe.qcow2 10G'
			].map((c) => commands.indexOf(c));
			expect(order.every((i) => i >= 0)).toBe(true);
			expect([...order].sort((a, b) => a - b)).toEqual(order);
			const seedUpload = calls.find((c) => c[0] === 'vol-upload' && c[3] === 'lvprobe-cidata.iso')!;
			expect(seedUpload).toBeDefined();
			expect(defined).toHaveLength(1);
			expect(defined[0]).toContain("<source file='/pool/lvprobe.qcow2'/>");
			expect(defined[0]).toMatch(/<source file='\/pool\/lvprobe-cidata\.iso'\/><target dev='sda' bus='scsi'\/><readonly\/><\/disk>/);
			expect(defined[0]).not.toContain("<boot order='1'/>");
			expect(progress.at(-1)).toBe(1);
		});

		it('never shrinks an image larger than the asked size', async () => {
			const { connection, calls } = await connectKeepingXml({ 'vol-dumpxml --pool default lvprobe.qcow2': volXml('qcow2', 20) });
			await connection.createVm('host', values);
			expect(calls.some((c) => c[0] === 'vol-resize')).toBe(false);
		});

		it('keeps a raw image raw', async () => {
			const { connection, calls, defined } = await connectKeepingXml({ 'vol-dumpxml --pool default lvprobe.img': volXml('raw', 20), 'vol-path --pool default lvprobe.img': '/pool/lvprobe.img\n' });
			await connection.createVm('host', { ...values, cloudImageFile: raw });
			expect(calls.map((c) => c.join(' '))).toContain('vol-create-as default lvprobe.img 2048b --format raw');
			expect(defined[0]).toContain("<driver name='qemu' type='raw' discard='unmap'/><source file='/pool/lvprobe.img'/>");
		});

		it('removes both new volumes when the definition fails', async () => {
			const { connection, calls } = await connectKeepingXml({ define: new Error('error: boom') });
			await expect(connection.createVm('host', values)).rejects.toBeTruthy();
			const commands = calls.map((c) => c.join(' '));
			expect(commands).toContain('vol-delete --pool default lvprobe.qcow2');
			expect(commands).toContain('vol-delete --pool default lvprobe-cidata.iso');
		});

		it('refuses before touching storage: no way to sign in, a missing file, an image for another architecture', async () => {
			const { connection, calls } = await connectKeepingXml();
			await expect(connection.createVm('host', { ...values, ciSshKey: '' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('SSH public key or a password') });
			await expect(connection.createVm('host', { ...values, cloudImageFile: join(scratch, 'nope.qcow2') })).rejects.toMatchObject({ code: 'invalid' });
			await expect(connection.createVm('host', { ...values, cloudImage: 'debian-13@x86_64' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('x86_64') });
			expect(calls.some((c) => c[0] === 'vol-create-as' || c[0] === 'pool-define-as')).toBe(false);
		});

		it('deletes the seed volume with the disks', async () => {
			const xml = XML.replace("<source index='1'/>", "<source file='/pool/lvprobe-cidata.iso' index='1'/>");
			const { connection, calls } = await connect({ dumpxml: xml });
			await connection.deleteVm('host', UUID, { deleteDisks: true });
			const undefine = calls.find((c) => c[0] === 'undefine')!;
			expect(undefine.at(-1)!.split(',')).toEqual(expect.arrayContaining(['sda']));
		});

		it('reads format and capacity of a volume', () => {
			expect(parseVolumeXml(volXml('qcow2', 3))).toEqual({ format: 'qcow2', capacity: 3 * 1024 ** 3 });
			expect(parseVolumeXml('<volume/>')).toEqual({});
		});
	});
	describe('port forwards', () => {
		const USER_XML = XML.includes("<interface type='user'>") ? XML : XML.replace(/<interface type='[^']*'>/, "<interface type='user'>");
		const INFO_NETWORK = 'net0: index=0,type=nic,model=virtio-net-pci\n \\ hostnet0: index=0,type=user,net=10.0.2.0\n';
		const saved = `<forwards><forward protocol='tcp' hostAddress='127.0.0.1' hostPort='2222' guestPort='22'/></forwards>`;
		const hmp = (calls: string[][]) => calls.filter((c) => c[0] === 'qemu-monitor-command').map((c) => c[3]);

		it('adds a forward to the running domain and saves it in the metadata', async () => {
			const { connection, calls } = await connect({ dumpxml: USER_XML, domstate: 'running\n', [`qemu-monitor-command ${UUID} --hmp info network`]: INFO_NETWORK });
			expect(connection.capabilities.forwards).toBe(true);
			await connection.addPortForward!('host', UUID, { protocol: 'tcp', hostPort: 2222, guestPort: 22 });
			expect(hmp(calls)).toContain('hostfwd_add hostnet0 tcp:127.0.0.1:2222-:22');
			const set = calls.find((c) => c[0] === 'metadata' && c.includes('--set'))!;
			expect(set).toEqual(['metadata', UUID, '--uri', 'https://sourceregistry.dev/vm-manager/forwards', '--key', 'vmm', '--set', saved, '--config']);
		});
		it('does not save a forward QEMU refused', async () => {
			const { connection, calls } = await connect({ dumpxml: USER_XML, domstate: 'running\n', [`qemu-monitor-command ${UUID} --hmp info network`]: INFO_NETWORK, [`qemu-monitor-command ${UUID} --hmp hostfwd_add hostnet0 tcp:127.0.0.1:2222-:22`]: "Could not set up host forwarding rule 'tcp:127.0.0.1:2222-:22'" });
			await expect(connection.addPortForward!('host', UUID, { protocol: 'tcp', hostPort: 2222, guestPort: 22 })).rejects.toMatchObject({ message: expect.stringContaining('in use') });
			expect(calls.some((c) => c[0] === 'metadata' && c.includes('--set'))).toBe(false);
		});
		it('reports saved forwards and adds missing ones to a running domain started elsewhere', async () => {
			const { connection, calls } = await connect({ dumpxml: USER_XML, domstate: 'running\n', metadata: saved, [`qemu-monitor-command ${UUID} --hmp info network`]: INFO_NETWORK, [`qemu-monitor-command ${UUID} --hmp info usernet`]: 'Hub -1 (hostnet0):\n' });
			const details = await connection.getVmDetails('host', UUID);
			expect(details.forwards).toEqual([{ protocol: 'tcp', hostAddress: '127.0.0.1', hostPort: 2222, guestPort: 22 }]);
			expect(hmp(calls)).toContain('hostfwd_add hostnet0 tcp:127.0.0.1:2222-:22');
		});
		it('removes a forward from QEMU and the metadata', async () => {
			const { connection, calls } = await connect({ dumpxml: USER_XML, domstate: 'running\n', metadata: saved, [`qemu-monitor-command ${UUID} --hmp info network`]: INFO_NETWORK });
			await connection.removePortForward!('host', UUID, { protocol: 'tcp', hostPort: 2222, guestPort: 22 });
			expect(hmp(calls)).toContain('hostfwd_remove hostnet0 tcp:127.0.0.1:2222');
			expect(calls.some((c) => c[0] === 'metadata' && c.includes('--remove'))).toBe(true);
		});
		it('refuses forwards on a remote host and on a libvirt network', async () => {
			const remote = await connect({ dumpxml: USER_XML }, { connection: 'ssh', sshHost: 'lab' });
			expect(remote.connection.capabilities.forwards).toBe(false);
			await expect(remote.connection.addPortForward!('host', UUID, { protocol: 'tcp', hostPort: 2222, guestPort: 22 })).rejects.toMatchObject({ code: 'unsupported' });
			const bridged = await connect({ dumpxml: USER_XML.replace("<interface type='user'>", "<interface type='network'><source network='default'/>") });
			await expect(bridged.connection.addPortForward!('host', UUID, { protocol: 'tcp', hostPort: 2222, guestPort: 22 })).rejects.toMatchObject({ code: 'unsupported' });
		});
	});
	it('says so when the display port refuses the connection', async () => {
		const { connection } = await connect({ domstate: 'running\n', dumpxml: XML.replace("port='5900'", "port='1'") });
		await expect(connection.openConsole('host', UUID, 'vnc')).rejects.toMatchObject({ code: 'unavailable' });
	});
});
