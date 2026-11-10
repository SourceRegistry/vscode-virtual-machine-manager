import { describe, expect, it } from 'vitest';
import { appendBlock, describeConfigHost, parseSshCommand, parseSshConfig, parseUserAtHost, renderNewHostBlock } from '../src/shared/sshConfigHosts';

describe('parseSshConfig', () => {
	it('lists aliases with what the entry says about them', () => {
		const text = `
# my machines
Host 145.24.223.247
  HostName 145.24.223.247
  User root

Host aquabots.tech web
  HostName aquabots.tech
  Port 2222
  User deploy

Host *
  ServerAliveInterval 30
`;
		const { hosts } = parseSshConfig(text);
		expect(hosts).toEqual([
			{ alias: '145.24.223.247', hostName: '145.24.223.247', user: 'root' },
			{ alias: 'aquabots.tech', hostName: 'aquabots.tech', port: 2222, user: 'deploy' },
			{ alias: 'web', hostName: 'aquabots.tech', port: 2222, user: 'deploy' }
		]);
	});

	it('leaves out patterns and negations, keeps the first value, and understands = and case', () => {
		const { hosts } = parseSshConfig('host a b* !c d?\n  hostname=one\n  HostName two\n  PORT = 22\nHost d1\nHost a\n  User late\n');
		expect(hosts).toEqual([{ alias: 'a', hostName: 'one', port: 22 }, { alias: 'd1' }]);
	});

	it('does not give Match settings to the previous host, and collects includes', () => {
		const { hosts, includes } = parseSshConfig('Include config.d/* ~/other\nHost a\n  User x\nMatch host b\n  User y\nHost c # trailing\n  HostName c.example\n');
		expect(includes).toEqual(['config.d/*', '~/other']);
		expect(hosts).toEqual([{ alias: 'a', user: 'x' }, { alias: 'c', hostName: 'c.example' }]);
	});

	it('copes with CRLF, empty input and junk', () => {
		expect(parseSshConfig('Host a\r\n  HostName b\r\n').hosts).toEqual([{ alias: 'a', hostName: 'b' }]);
		expect(parseSshConfig('').hosts).toEqual([]);
		expect(parseSshConfig('garbage\n===\n').hosts).toEqual([]);
	});

	it('finds the VM Manager entries too (they are ordinary hosts)', () => {
		const { hosts } = parseSshConfig('# BEGIN VM Manager: c/n/v\nHost vmm-web-1a2b\n  HostName 127.0.0.1\n  Port 2222\n  User debian\n# END VM Manager: c/n/v\n');
		expect(hosts).toEqual([{ alias: 'vmm-web-1a2b', hostName: '127.0.0.1', port: 2222, user: 'debian' }]);
	});
});

describe('describeConfigHost', () => {
	it('shows where an alias leads, nothing when it adds nothing', () => {
		expect(describeConfigHost({ alias: 'web', hostName: 'aquabots.tech', user: 'deploy', port: 2222 })).toBe('deploy@aquabots.tech:2222');
		expect(describeConfigHost({ alias: 'a', hostName: 'a' })).toBeUndefined();
		expect(describeConfigHost({ alias: 'a' })).toBeUndefined();
		expect(describeConfigHost({ alias: 'a', user: 'me' })).toBe('me@a');
	});
});

describe('parseUserAtHost', () => {
	it('accepts host, user@host and addresses; refuses option-like input', () => {
		expect(parseUserAtHost('lab')).toEqual({ user: undefined, host: 'lab' });
		expect(parseUserAtHost('root@10.0.0.5')).toEqual({ user: 'root', host: '10.0.0.5' });
		expect(parseUserAtHost('me@fe80::1')).toEqual({ user: 'me', host: 'fe80::1' });
		for (const bad of ['', '-oProxyCommand=x', 'a b', 'u@', '@h', 'x;y', '-x@h']) expect(parseUserAtHost(bad), bad).toBeUndefined();
	});
});

describe('parseSshCommand', () => {
	it('understands what is pasted from a terminal', () => {
		expect(parseSshCommand('ssh user@host')).toEqual({ host: 'host', user: 'user', port: undefined, identityFile: undefined });
		expect(parseSshCommand('ssh -p 2222 root@10.0.0.5')).toMatchObject({ host: '10.0.0.5', user: 'root', port: 2222 });
		expect(parseSshCommand('host -l me -i ~/.ssh/key')).toMatchObject({ host: 'host', user: 'me', identityFile: '~/.ssh/key' });
		expect(parseSshCommand('user@host -p 22')).toMatchObject({ port: 22 });
	});
	it('refuses what it cannot represent instead of dropping it', () => {
		expect(parseSshCommand('')).toMatch(/Enter a host/);
		expect(parseSshCommand('ssh -J jump host')).toMatch(/cannot be added here/);
		expect(parseSshCommand('ssh -o ProxyCommand=x host')).toMatch(/cannot be added here/);
		expect(parseSshCommand('ssh a b')).toMatch(/one host/);
		expect(parseSshCommand('ssh -p 99999 h')).toMatch(/not a valid port/);
		expect(parseSshCommand('ssh -p')).toMatch(/needs a value/);
		expect(parseSshCommand('ssh -- x')).toMatch(/cannot be added here/);
		expect(parseSshCommand('ssh h -i "/my keys/id"')).toMatch(/spaces or quotes/);
		expect(parseSshCommand('ssh -l "a b" h')).toMatch(/not a valid user/);
		expect(parseSshCommand('ssh -oProxyCommand=x')).toMatch(/cannot be added here/);
	});
});

describe('new host block', () => {
	it('renders only what was given and appends with a blank line', () => {
		expect(renderNewHostBlock({ host: 'h', user: 'u', port: 2200, identityFile: '~/.ssh/k' })).toBe('Host h\n  HostName h\n  User u\n  Port 2200\n  IdentityFile ~/.ssh/k');
		expect(renderNewHostBlock({ host: 'h' })).toBe('Host h\n  HostName h');
		expect(appendBlock('', 'Host a')).toBe('Host a\n');
		expect(appendBlock('Host x\n  User y\n\n\n', 'Host a')).toBe('Host x\n  User y\n\nHost a\n');
	});
	it('round-trips through the parser', () => {
		const block = renderNewHostBlock({ host: '145.24.223.9', user: 'root', port: 2200 });
		expect(parseSshConfig(appendBlock('Host old\n  User o\n', block)).hosts).toEqual([
			{ alias: 'old', user: 'o' },
			{ alias: '145.24.223.9', hostName: '145.24.223.9', user: 'root', port: 2200 }
		]);
	});
});
