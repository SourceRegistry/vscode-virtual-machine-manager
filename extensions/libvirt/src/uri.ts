import type { FieldValues } from '@vmm/sdk';
import { ProviderError } from '@vmm/sdk';

/** What the cluster form holds, turned into the connection URI virsh is given with `-c`. */
export function buildUri(config: FieldValues): string {
	switch (String(config.connection ?? 'session')) {
		case 'system': return 'qemu:///system';
		case 'session': return 'qemu:///session';
		case 'ssh': {
			const scope = config.scope === 'session' ? 'session' : 'system';
			const host = String(config.sshHost ?? '').trim();
			// A host is a name or an address: never something ssh or a URI would read as more.
			if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$|^\[[0-9A-Fa-f:.]+\]$/.test(host)) throw new ProviderError('Enter the SSH host as a name or an address (or an alias of ~/.ssh/config).', 'invalid');
			const user = String(config.sshUser ?? '').trim();
			if (user && !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(user)) throw new ProviderError('The SSH user name has characters that are not allowed.', 'invalid');
			const port = config.sshPort === undefined || config.sshPort === '' ? undefined : Number(config.sshPort);
			if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new ProviderError('The SSH port must be between 1 and 65535.', 'invalid');
			// `no_tty=1`: ssh never prompts, so a missing key or an unknown host key is an error, not a hang.
			return `qemu+ssh://${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}/${scope}?no_tty=1`;
		}
		case 'custom': {
			const uri = String(config.uri ?? '').trim();
			if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]*$/i.test(uri)) throw new ProviderError('Enter a libvirt URI such as qemu:///system or qemu+ssh://user@host/system.', 'invalid');
			return uri;
		}
		default:
			throw new ProviderError('Unknown connection type.', 'invalid');
	}
}

/** The hypervisor runs on this computer (no host in the URI, no remote transport). */
export function isLocalUri(uri: string): boolean {
	const match = /^([a-z0-9.-]+)(?:\+([a-z0-9]+))?:\/\/([^/?]*)/i.exec(uri);
	return !!match && !match[2] && !match[3];
}

export interface SshTarget { host: string; user?: string; port?: number }

/** The ssh destination of a `qemu+ssh://` URI, used to reach a VNC or serial port on that host. */
export function sshTarget(uri: string): SshTarget | undefined {
	const match = /^[a-z0-9.-]+\+ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/?]+)(?::(\d+))?/i.exec(uri);
	if (!match) return undefined;
	return { host: match[2]!.replace(/^\[|\]$/g, ''), ...(match[1] ? { user: match[1] } : {}), ...(match[3] ? { port: Number(match[3]) } : {}) };
}

/** Shown in the tree while connecting: where the machines run, when that is another computer. */
export function remoteLabel(config: FieldValues): string | undefined {
	if (config.connection === 'ssh') return `ssh ${config.sshUser ? `${config.sshUser}@` : ''}${config.sshHost ?? ''}`.trim();
	if (config.connection === 'custom') {
		const target = sshTarget(String(config.uri ?? ''));
		if (target) return `ssh ${target.user ? `${target.user}@` : ''}${target.host}`;
	}
	return undefined;
}
