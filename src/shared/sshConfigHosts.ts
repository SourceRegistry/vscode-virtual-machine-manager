/** Reading the hosts out of an ssh config, and turning "ssh user@host -p 22" into a new entry. Pure, unit tested. */

export interface ConfigHost {
	alias: string;
	hostName?: string;
	user?: string;
	port?: number;
}

export interface ParsedSshConfig {
	hosts: ConfigHost[];
	/** `Include` arguments in file order, as written. */
	includes: string[];
}

function tokens(text: string): string[] {
	const result: string[] = [];
	for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) result.push(match[1] ?? match[2]!);
	return result;
}

/**
 * The hosts a config names. A `Host` line can list several aliases; patterns (`*`, `?`, `!`) are not
 * machines and are left out, and settings under a `Match` block belong to no alias. As ssh does, the
 * first value of a setting wins.
 */
export function parseSshConfig(text: string): ParsedSshConfig {
	const hosts: ConfigHost[] = [];
	const includes: string[] = [];
	let current: ConfigHost[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/(^|\s)#.*$/, '').trim();
		if (!line) continue;
		const match = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
		if (!match) continue;
		const keyword = match[1]!.toLowerCase();
		const args = match[2]!.trim();
		if (keyword === 'host') {
			current = [];
			for (const alias of tokens(args)) {
				if (/[*?!]/.test(alias) || hosts.some((h) => h.alias === alias)) continue;
				const host: ConfigHost = { alias };
				hosts.push(host);
				current.push(host);
			}
		} else if (keyword === 'match') {
			current = [];
		} else if (keyword === 'include') {
			includes.push(...tokens(args));
		} else if (keyword === 'hostname') {
			for (const host of current) host.hostName ??= tokens(args)[0];
		} else if (keyword === 'user') {
			for (const host of current) host.user ??= tokens(args)[0];
		} else if (keyword === 'port') {
			const port = Number(tokens(args)[0]);
			if (Number.isInteger(port) && port > 0) for (const host of current) host.port ??= port;
		}
	}
	return { hosts, includes };
}

/** `user@host:port`, as far as the entry says. */
export function describeConfigHost(host: ConfigHost): string | undefined {
	if (!host.hostName && !host.user && !host.port) return undefined;
	const target = `${host.user ? `${host.user}@` : ''}${host.hostName ?? host.alias}${host.port ? `:${host.port}` : ''}`;
	return target === host.alias ? undefined : target;
}

export interface SshCommand {
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
}

const HOST = /^[A-Za-z0-9.:_-]{1,253}$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

/** `user@host` (or just `host`): the way a host is typed. `undefined` when it is neither. */
export function parseUserAtHost(text: string): { user?: string; host: string } | undefined {
	const at = text.lastIndexOf('@');
	if (at === 0) return undefined;
	const user = at > 0 ? text.slice(0, at) : undefined;
	const host = at >= 0 ? text.slice(at + 1) : text;
	if (!HOST.test(host) || host.startsWith('-')) return undefined;
	if (user !== undefined && !USER.test(user)) return undefined;
	return { user, host };
}

/**
 * Understands what people paste: `ssh user@host`, `ssh -p 2222 user@host`, `user@host -i ~/.ssh/key`. Anything else
 * ssh accepts (jump hosts, options) is refused with a pointer to the config file, so nothing is silently dropped.
 */
export function parseSshCommand(input: string): SshCommand | string {
	const words = tokens(input.trim());
	if (words[0] === 'ssh') words.shift();
	let destination: string | undefined;
	let port: number | undefined;
	let user: string | undefined;
	let identityFile: string | undefined;
	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		if (word === '-p' || word === '-l' || word === '-i') {
			const value = words[++i];
			if (value === undefined) return `${word} needs a value.`;
			if (word === '-p') {
				port = Number(value);
				if (!Number.isInteger(port) || port < 1 || port > 65535) return `${value} is not a valid port.`;
			} else if (word === '-l') {
				user = value;
			} else {
				identityFile = value;
			}
		} else if (word.startsWith('-')) {
			return `ssh option ${word} cannot be added here. Use "Configure SSH Hosts…" to write the entry yourself.`;
		} else if (destination === undefined) {
			destination = word;
		} else {
			return 'Enter one host, for example: ssh user@host -p 22';
		}
	}
	if (!destination) return 'Enter a host, for example: ssh user@host';
	const parsed = parseUserAtHost(destination);
	if (!parsed) return `"${destination}" is not a valid host or user@host.`;
	const finalUser = parsed.user ?? user;
	if (finalUser !== undefined && !USER.test(finalUser)) return `"${finalUser}" is not a valid user name.`;
	if (identityFile !== undefined && (/[\s"'\\]/.test(identityFile) || identityFile.startsWith('-'))) return 'The key path may not contain spaces or quotes. Use "Configure SSH Hosts…" for that.';
	return { host: parsed.host, user: finalUser, port, identityFile };
}

/** The block appended to the config for a new host. */
export function renderNewHostBlock(entry: SshCommand): string {
	return [
		`Host ${entry.host}`,
		`  HostName ${entry.host}`,
		...(entry.user ? [`  User ${entry.user}`] : []),
		...(entry.port ? [`  Port ${entry.port}`] : []),
		...(entry.identityFile ? [`  IdentityFile ${entry.identityFile}`] : [])
	].join('\n');
}

/** Appends a block with a blank line between it and what is there. */
export function appendBlock(text: string, block: string): string {
	const base = text.replace(/\s+$/, '');
	return `${base ? `${base}\n\n` : ''}${block}\n`;
}
