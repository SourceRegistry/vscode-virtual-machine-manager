/** A machine's activity log: what was done to it from VS Code and what it did. Pure, unit tested. */

export type ActivityLevel = 'info' | 'warn' | 'error';

export interface ActivityEntry {
	at: number;
	level: ActivityLevel;
	text: string;
}

/** Entries kept per machine; older ones drop off. */
export const ACTIVITY_LIMIT = 500;

/** Adds an entry, dropping the oldest past `limit`. Returns the same array. */
export function appendEntry(entries: ActivityEntry[], entry: ActivityEntry, limit = ACTIVITY_LIMIT): ActivityEntry[] {
	entries.push(entry);
	if (entries.length > limit) entries.splice(0, entries.length - limit);
	return entries;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `2026-11-12 14:03:07.123` in local time, like VS Code's own logs. */
export function timestamp(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** One line per entry; a multi-line text is indented under its first line. */
export function formatEntry(entry: ActivityEntry): string {
	const [first, ...rest] = entry.text.split('\n');
	const head = `${timestamp(entry.at)} [${entry.level}] ${first}`;
	return rest.length ? [head, ...rest.map((line) => `    ${line}`)].join('\n') : head;
}

export interface LogDocument {
	name: string;
	where: string;
	entries: readonly ActivityEntry[];
	/** The hypervisor's own log for the machine (QEMU's output, libvirt's domain log), when the provider has one. */
	hypervisorLog?: string;
	/** Why there is no hypervisor log, when there is none. */
	hypervisorLogNote?: string;
}

/** The text of the read-only log document. */
export function formatLogDocument(doc: LogDocument): string {
	const lines = [
		`# ${doc.name} (${doc.where})`,
		'# What VM Manager did and saw since VS Code started. The document updates as things happen.',
		''
	];
	if (doc.entries.length) lines.push(...doc.entries.map(formatEntry));
	else lines.push('(nothing yet)');
	if (doc.hypervisorLog !== undefined || doc.hypervisorLogNote) {
		lines.push('', '# Hypervisor log', '');
		lines.push(doc.hypervisorLog?.trimEnd() || doc.hypervisorLogNote || '(empty)');
	}
	return `${lines.join('\n')}\n`;
}

/** The last `maxBytes` of a log, cut at a line start, with a note that the start is missing. */
export function tail(text: string, maxBytes = 64 * 1024): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) return text;
	const cut = new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
	const newline = cut.indexOf('\n');
	return `[… earlier lines left out]\n${newline >= 0 ? cut.slice(newline + 1) : cut}`;
}
