import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRemotePath } from '@vmm/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalHost } from '../src/host';
import {
	explainSshError,
	nodeArch,
	parseChildren,
	parseHostInfo,
	parseListeningPorts,
	parseLs,
	parseProcStatCpu,
	shellCommand,
	shq,
	sshBaseArgs,
	SshHost,
	validateSshTarget
} from '../src/sshHost';

const FAKE_SSH = path.resolve(__dirname, 'fakeSsh.mjs');

describe('shell quoting', () => {
	it('quotes words so the remote shell sees them unchanged', () => {
		expect(shq('plain')).toBe("'plain'");
		expect(shq("it's")).toBe(`'it'\\''s'`);
		expect(shq('a b; rm -rf /')).toBe("'a b; rm -rf /'");
		expect(shellCommand('qemu-img', ['info', '/vm dir/$HOME'])).toBe("'qemu-img' 'info' '/vm dir/$HOME'");
	});
});

describe('target validation', () => {
	it('accepts hosts, aliases and addresses', () => {
		for (const host of ['server', 'vmm-lab-1a2b', 'example.com', '192.168.1.5', 'fe80::1', '[::1]', 'user@host']) {
			expect(validateSshTarget({ host })).toBeUndefined();
		}
	});
	it('rejects anything ssh could read as an option or a second command', () => {
		for (const host of ['', '-oProxyCommand=x', '-v', 'a b', 'host;reboot', 'a$(b)', 'a\nb']) {
			expect(validateSshTarget({ host }), host).toBeTruthy();
		}
		expect(validateSshTarget({ host: 'h', user: '-l' })).toBeTruthy();
		expect(validateSshTarget({ host: 'h', user: 'a b' })).toBeTruthy();
		expect(validateSshTarget({ host: 'h', port: 0 })).toBeTruthy();
		expect(validateSshTarget({ host: 'h', port: 70000 })).toBeTruthy();
		expect(validateSshTarget({ host: 'h', identityFile: '-F/etc/passwd' })).toBeTruthy();
		expect(validateSshTarget({ host: 'h', user: 'root', port: 2222, identityFile: '/home/me/.ssh/id' })).toBeUndefined();
	});
});

describe('ssh arguments', () => {
	it('never asks anything, and passes only what was configured', () => {
		const args = sshBaseArgs({ host: 'h' });
		expect(args).toContain('BatchMode=yes');
		expect(args).not.toContain('-p');
		expect(args).not.toContain('-l');
		expect(args).not.toContain('-i');
		expect(args).not.toContain('ControlMaster=auto');
	});
	it('adds port, user, key and multiplexing', () => {
		const args = sshBaseArgs({ host: 'h', user: 'root', port: 2200, identityFile: '/k' }, { controlDir: '/tmp/x' });
		expect(args.join(' ')).toContain('-p 2200');
		expect(args.join(' ')).toContain('-l root');
		expect(args.join(' ')).toContain('-i /k -o IdentitiesOnly=yes');
		expect(args.join(' ')).toContain('ControlPath=/tmp/x/%C');
	});
});

describe('error explanations', () => {
	const t = { host: 'lab', user: 'me' };
	it('tells the user what to do', () => {
		expect(explainSshError('Host key verification failed.', t)).toMatch(/known_hosts.*ssh lab/);
		expect(explainSshError('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.', t)).toMatch(/ssh-keygen -R lab/);
		expect(explainSshError('me@lab: Permission denied (publickey,password).', t)).toMatch(/cannot type a password/);
		expect(explainSshError('ssh: Could not resolve hostname lab: Name or service not known', t)).toMatch(/could not be resolved/);
		expect(explainSshError('ssh: connect to host lab port 22: Connection refused', t)).toMatch(/sshd/);
		expect(explainSshError('something odd\nlast line', t)).toBe('something odd last line');
	});
});

describe('remote path fields', () => {
	it('offers no file dialog for a path on another computer', () => {
		const base = { key: 'p', label: 'P', type: 'file' as const };
		expect(isRemotePath(base, {})).toBe(false);
		expect(isRemotePath({ ...base, remotePath: true }, {})).toBe(true);
		expect(isRemotePath({ ...base, remotePath: 'sshHost' }, {})).toBe(false);
		expect(isRemotePath({ ...base, remotePath: 'sshHost' }, { sshHost: '' })).toBe(false);
		expect(isRemotePath({ ...base, remotePath: 'sshHost' }, { sshHost: 'lab' })).toBe(true);
	});
});

describe('output parsers', () => {
	it('lists directories from ls -1Ap', () => {
		expect(parseLs('a/\nb.txt\n.hidden/\n')).toEqual([
			{ name: 'a', isDirectory: true },
			{ name: 'b.txt', isDirectory: false },
			{ name: '.hidden', isDirectory: true }
		]);
	});
	it('finds listening ports in ss, Linux netstat and macOS netstat output', () => {
		const ss = 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:5900 0.0.0.0:*\nLISTEN 0 128 [::]:8080 [::]:*\nESTAB 0 0 10.0.0.1:44000 10.0.0.2:22';
		expect([...parseListeningPorts(ss)].sort((a, b) => a - b)).toEqual([22, 5900, 8080]);
		expect([...parseListeningPorts('tcp 0 0 0.0.0.0:3306 0.0.0.0:* LISTEN')]).toEqual([3306]);
		expect([...parseListeningPorts('tcp4 0 0 127.0.0.1.5901 *.* LISTEN\ntcp4 0 0 10.0.0.1.50000 1.2.3.4.443 ESTABLISHED')]).toEqual([5901]);
	});
	it('splits the per-directory file dump', () => {
		const out = '@@VMM@@aaa\n{"id":"aaa"}\n@@VMM@@bbb\n{\n  "id": "bbb"\n}\n';
		expect(parseChildren(out)).toEqual([
			['aaa', '{"id":"aaa"}'],
			['bbb', '{\n  "id": "bbb"\n}']
		]);
		expect(parseChildren('')).toEqual([]);
	});
	it('reads the host facts', () => {
		const info = parseHostInfo('lab\n8\nLinux x86_64\nMemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\ncpu  100 0 50 800 50 0 0 0 0 0\n');
		expect(info).toMatchObject({ hostname: 'lab', cpus: 8, system: 'Linux', machine: 'x86_64', memoryMB: 16000, availableMB: 8000 });
		expect(info.cpu).toEqual({ idle: 850, total: 1000 });
		expect(parseProcStatCpu('intr 1 2')).toBeUndefined();
		expect(nodeArch('aarch64')).toBe('arm64');
		expect(nodeArch('x86_64')).toBe('x64');
	});
});

describe('SshHost through a stand-in ssh', () => {
	let dir: string;
	let host: SshHost;
	let server: net.Server;
	let serverPort: number;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-sshhost-'));
		host = new SshHost({ host: 'lab' }, { command: FAKE_SSH, anyPlatform: true });
		await host.ping();
		server = net.createServer((socket) => socket.end('RFB 003.008\n'));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		serverPort = (server.address() as net.AddressInfo).port;
	});

	afterAll(() => {
		host.dispose();
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reads and writes files with awkward names and content', async () => {
		const file = path.join(dir, "it's a file.json");
		const text = '{"a":"$HOME `x` \\n"}\n\nlast';
		await host.writeFile(file, text);
		expect(await host.readFile(file)).toBe(text);
		expect(await host.exists(file)).toBe(true);
		expect(await host.exists(path.join(dir, 'nope'))).toBe(false);
		await expect(host.readFile(path.join(dir, 'nope'))).rejects.toThrow();
	});

	it('makes, lists, copies and removes', async () => {
		await host.mkdir(path.join(dir, 'a', 'b'));
		await host.writeFile(path.join(dir, 'a', 'f.txt'), 'x');
		await host.copyFile(path.join(dir, 'a', 'f.txt'), path.join(dir, 'a', 'g.txt'));
		const entries = (await host.readdir(path.join(dir, 'a'))).sort((x, y) => x.name.localeCompare(y.name));
		expect(entries).toEqual([
			{ name: 'b', isDirectory: true },
			{ name: 'f.txt', isDirectory: false },
			{ name: 'g.txt', isDirectory: false }
		]);
		expect(await host.readdir(path.join(dir, 'missing'))).toEqual([]);
		await host.rm(path.join(dir, 'a'), { recursive: true });
		expect(await host.exists(path.join(dir, 'a'))).toBe(false);
		await host.rm(path.join(dir, 'a'), { recursive: true }); // already gone: fine
	});

	it('reads one file from every sub-directory that has it', async () => {
		for (const name of ['one', 'two', 'empty']) await host.mkdir(path.join(dir, 'vms', name));
		await host.writeFile(path.join(dir, 'vms', 'one', 'vm.json'), '{"n":1}');
		await host.writeFile(path.join(dir, 'vms', 'two', 'vm.json'), '{"n":2}');
		const found = (await host.readChildren(path.join(dir, 'vms'), 'vm.json')).sort(([a], [b]) => a.localeCompare(b));
		expect(found).toEqual([
			['one', '{"n":1}'],
			['two', '{"n":2}']
		]);
		expect(await host.readChildren(path.join(dir, 'does-not-exist'), 'vm.json')).toEqual([]);
	});

	it('runs a program that outlives the session, and stops it', async () => {
		const log = path.join(dir, 'sleep.log');
		const pid = await host.spawnDetached('sh', ['-c', 'echo started; sleep 30'], { cwd: dir, logFile: log });
		expect(pid).toBeGreaterThan(1);
		expect(await host.isAlive(pid)).toBe(true);
		expect(await host.readFile(log)).toContain('started');
		await host.signal(pid, 'SIGTERM');
		for (let i = 0; i < 20 && (await host.isAlive(pid)); i++) await new Promise((r) => setTimeout(r, 100));
		expect(await host.isAlive(pid)).toBe(false);
		expect(await host.isAlive(0)).toBe(false);
	});

	it('opens a tunnel to a port on the host and reports one that is closed', async () => {
		const stream = await host.connect(serverPort);
		const received = await new Promise<string>((resolve) => stream.once('data', (d: Buffer) => resolve(d.toString())));
		expect(received).toBe('RFB 003.008\n');
		stream.destroy();

		const closed = net.createServer();
		await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
		const port = (closed.address() as net.AddressInfo).port;
		await new Promise((r) => closed.close(r));
		await expect(host.connect(port)).rejects.toThrow(/nothing is listening|forbids/);
	});

	it('finds a free port on the host, within a range and outside the ones to avoid', async () => {
		const port = await host.freePort(undefined, undefined, new Set());
		expect(port).toBeGreaterThanOrEqual(20000);
		const ranged = await host.freePort(45000, 45010, new Set([45000, 45001]));
		expect(ranged).toBeGreaterThanOrEqual(45002);
		await expect(host.freePort(45000, 45001, new Set([45000, 45001]))).rejects.toThrow(/No free TCP port/);
	});

	it('reports the host and a process', async () => {
		const info = await host.info();
		expect(info.cpus).toBeGreaterThan(0);
		expect(info.hostname).toBeTruthy();
		expect(await host.sampleProcess(2 ** 22 - 7)).toBeUndefined();
	});

	it('says why a host cannot be reached', async () => {
		const bad = new SshHost({ host: 'unreachable.invalid' }, { command: FAKE_SSH, anyPlatform: true });
		await expect(bad.ping()).rejects.toThrow(/could not be resolved/);
		bad.dispose();
	});

	it('refuses an invalid target before running anything', () => {
		expect(() => new SshHost({ host: '-oProxyCommand=touch /tmp/pwned' })).toThrow(/not a valid SSH host/);
	});
});

describe('LocalHost', () => {
	it('does what the provider used to do directly', async () => {
		const host = new LocalHost();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-localhost-'));
		try {
			await host.mkdir(path.join(dir, 'vms', 'a'));
			await host.writeFile(path.join(dir, 'vms', 'a', 'vm.json'), '{"id":"a"}');
			await host.mkdir(path.join(dir, 'vms', 'b'));
			expect(await host.readChildren(path.join(dir, 'vms'), 'vm.json')).toEqual([['a', '{"id":"a"}']]);
			expect(await host.exists(path.join(dir, 'vms', 'a'))).toBe(true);
			await host.rm(path.join(dir, 'vms', 'a', 'vm.json'));
			await host.rm(path.join(dir, 'vms', 'missing'));
			await host.rm(path.join(dir, 'vms'), { recursive: true });
			expect(await host.exists(path.join(dir, 'vms'))).toBe(false);
			expect(await host.isAlive(process.pid)).toBe(true);
			expect(await host.isAlive(0)).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
