import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { appendBlock, parseSshCommand, parseSshConfig, renderNewHostBlock, type ConfigHost } from '../../shared/sshConfigHosts';
import { log } from '../util/log';
import { readSshConfig, sshConfigPath, writeSshConfig } from './connect';

const MAX_DEPTH = 6;

/** Files an `Include` argument names: relative ones are relative to ~/.ssh, `~` is the home directory, `*` and `?` match in the last segment. */
function expandInclude(pattern: string): string[] {
	const full = pattern.startsWith('~') ? path.join(os.homedir(), pattern.slice(1)) : path.isAbsolute(pattern) ? pattern : path.join(os.homedir(), '.ssh', pattern);
	if (!/[*?]/.test(path.basename(full))) return [full];
	const regex = new RegExp(`^${path.basename(full).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
	try {
		return fs
			.readdirSync(path.dirname(full))
			.filter((name) => regex.test(name))
			.sort()
			.map((name) => path.join(path.dirname(full), name));
	} catch {
		return [];
	}
}

/** The hosts of the ssh config, with the files it includes. A missing or unreadable file is an empty list, not an error. */
export function loadSshConfigHosts(file = sshConfigPath()): ConfigHost[] {
	const hosts: ConfigHost[] = [];
	const seen = new Set<string>();
	const visit = (target: string, depth: number): void => {
		if (depth > MAX_DEPTH || seen.has(target)) return;
		seen.add(target);
		let text: string;
		try {
			text = fs.readFileSync(target, 'utf8');
		} catch {
			return;
		}
		const parsed = parseSshConfig(text);
		for (const host of parsed.hosts) if (!hosts.some((h) => h.alias === host.alias)) hosts.push(host);
		for (const include of parsed.includes) for (const inner of expandInclude(include)) visit(inner, depth + 1);
	};
	visit(file, 0);
	return hosts;
}

/**
 * "Add New SSH Host…": asks for what people type in a terminal (`ssh user@host -p 22`), shows the entry
 * and appends it to the ssh config after a confirmation. Returns the alias, or `undefined` when cancelled.
 */
export async function addSshHost(): Promise<string | undefined> {
	const file = sshConfigPath();
	const known = new Set(loadSshConfigHosts(file).map((h) => h.alias));
	const input = await vscode.window.showInputBox({
		title: 'Add New SSH Host',
		prompt: 'Enter the SSH connection command',
		placeHolder: 'ssh user@host -p 22',
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value.trim()) return undefined;
			const parsed = parseSshCommand(value);
			if (typeof parsed === 'string') return parsed;
			return known.has(parsed.host) ? `"${parsed.host}" is already in your ssh config.` : undefined;
		}
	});
	if (!input?.trim()) return undefined;
	const entry = parseSshCommand(input);
	if (typeof entry === 'string' || known.has(entry.host)) return undefined;
	const block = renderNewHostBlock(entry);
	const choice = await vscode.window.showInformationMessage(
		`Add "${entry.host}" to your ssh config?`,
		{ modal: true, detail: `${file}\n\nThis block is appended; the rest of the file is not touched (a copy is kept once as ${path.basename(file)}.vmm.bak):\n\n${block}` },
		'Add Host'
	);
	if (choice !== 'Add Host') return undefined;
	const current = readSshConfig(file);
	writeSshConfig(file, current, appendBlock(current, block));
	log.info(`Added ssh host ${entry.host} to ${file}`);
	return entry.host;
}

/** "Configure SSH Hosts…": opens the config next to whatever is asking, creating an empty private file when there is none. */
export async function openSshConfig(): Promise<void> {
	const file = sshConfigPath();
	if (!fs.existsSync(file)) writeSshConfig(file, '', '');
	await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false, preserveFocus: true });
}
