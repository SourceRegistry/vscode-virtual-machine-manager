import { describe, expect, it } from 'vitest';
import { buildUri, isLocalUri, remoteLabel, sshTarget } from '../src/uri';
import { explainVirshError, findVirsh } from '../src/virsh';

describe('connection URI', () => {
	it('builds the local ones', () => {
		expect(buildUri({})).toBe('qemu:///session');
		expect(buildUri({ connection: 'system' })).toBe('qemu:///system');
	});
	it('builds an ssh one that never prompts', () => {
		expect(buildUri({ connection: 'ssh', sshHost: 'lab', sshUser: 'me', sshPort: 2222, scope: 'system' })).toBe('qemu+ssh://me@lab:2222/system?no_tty=1');
		expect(buildUri({ connection: 'ssh', sshHost: 'lab', scope: 'session' })).toBe('qemu+ssh://lab/session?no_tty=1');
		expect(buildUri({ connection: 'ssh', sshHost: '[fe80::1]' })).toBe('qemu+ssh://[fe80::1]/system?no_tty=1');
	});
	it('refuses hosts and users that are more than a name', () => {
		for (const sshHost of ['', 'a b', 'x/y', '-oProxyCommand=x', '-o', 'a?b']) expect(() => buildUri({ connection: 'ssh', sshHost })).toThrow();
		expect(() => buildUri({ connection: 'ssh', sshHost: 'lab', sshUser: 'me;rm' })).toThrow();
		expect(() => buildUri({ connection: 'ssh', sshHost: 'lab', sshPort: 70000 })).toThrow();
		expect(() => buildUri({ connection: 'custom', uri: 'not a uri' })).toThrow();
		expect(buildUri({ connection: 'custom', uri: 'qemu+tcp://h/system' })).toBe('qemu+tcp://h/system');
	});
	it('knows what is local and where ssh goes', () => {
		expect(isLocalUri('qemu:///session')).toBe(true);
		expect(isLocalUri('qemu+ssh://me@lab/system')).toBe(false);
		expect(isLocalUri('qemu+tcp://h/system')).toBe(false);
		expect(sshTarget('qemu+ssh://me@lab:2222/system?no_tty=1')).toEqual({ host: 'lab', user: 'me', port: 2222 });
		expect(sshTarget('qemu+ssh://[fe80::1]/system')).toEqual({ host: 'fe80::1' });
		expect(sshTarget('qemu:///system')).toBeUndefined();
	});
	it('labels remote clusters', () => {
		expect(remoteLabel({ connection: 'ssh', sshHost: 'lab', sshUser: 'me' })).toBe('ssh me@lab');
		expect(remoteLabel({ connection: 'custom', uri: 'qemu+ssh://lab/system' })).toBe('ssh lab');
		expect(remoteLabel({ connection: 'session' })).toBeUndefined();
	});
});

describe('virsh', () => {
	it('finds virsh: configured, on PATH, or in a usual folder', () => {
		expect(findVirsh('/x/virsh', (f) => f === '/x/virsh')).toBe('/x/virsh');
		expect(findVirsh('/x/virsh', () => false)).toBeUndefined();
		expect(findVirsh(undefined, (f) => f === '/opt/homebrew/bin/virsh', '/usr/games', 'darwin')).toBe('/opt/homebrew/bin/virsh');
		expect(findVirsh(undefined, (f) => f === '/usr/games/virsh', '/x:/usr/games', 'linux')).toBe('/usr/games/virsh');
		expect(findVirsh(undefined, (f) => f === 'C:\\libvirt\\bin\\virsh.exe', 'C:\\Windows;C:\\libvirt\\bin', 'win32')).toBe('C:\\libvirt\\bin\\virsh.exe');
		expect(findVirsh(undefined, (f) => f === '/opt/homebrew/bin/virsh', '', 'win32')).toBeUndefined();
		expect(findVirsh(undefined, () => false, '', 'linux')).toBeUndefined();
	});
	it('explains errors', () => {
		expect(explainVirshError("error: failed to connect to the hypervisor\nerror: Failed to connect socket to '/run/libvirt/libvirt-sock': No such file or directory", 'qemu:///system')).toMatchObject({ code: 'unavailable', message: expect.stringContaining('Is libvirt running') });
		expect(explainVirshError('error: authentication failed: access denied by polkit', 'qemu:///system')).toMatchObject({ code: 'permission' });
		expect(explainVirshError('error: Cannot recv data: Host key verification failed.', 'qemu+ssh://h/system')).toMatchObject({ code: 'unavailable', message: expect.stringContaining('host key') });
		expect(explainVirshError('error: Domain not found: no domain with matching uuid', 'u')).toMatchObject({ code: 'notFound' });
		expect(explainVirshError('error: something else', 'u')).toMatchObject({ code: 'failed', message: 'something else' });
	});
});
