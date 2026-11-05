/**
 * Finds QEMU virtual machines that were not started by this extension, from the host process list.
 * Pure module (no I/O besides what the caller passes in), unit tested.
 */
import { splitArgs } from './definition';

export interface ProcessEntry {
	pid: number;
	command: string;
}

/** How to reach a running QEMU's QMP monitor. */
export interface QmpEndpoint {
	host?: string;
	port?: number;
	/** Unix domain socket path (Linux/macOS). */
	socket?: string;
}

/** A running QEMU found on the host, as far as its command line tells. */
export interface ExternalVm {
	pid: number;
	binary: string;
	name: string;
	cpus: number;
	memoryMB: number;
	disks: string[];
	cdrom?: string;
	/** Absent when QEMU was started without a usable monitor: the VM can then only be observed and killed. */
	qmp?: QmpEndpoint;
	/** TCP port of the VNC server on localhost, when there is one. */
	vncPort?: number;
	machine?: string;
	command: string;
}

/** `ps -axo pid=,command=` output → entries. */
export function parsePsList(text: string): ProcessEntry[] {
	const entries: ProcessEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match) entries.push({ pid: Number(match[1]), command: match[2]!.trim() });
	}
	return entries;
}

/** `qemu-system-x86_64`, `qemu-system-aarch64.exe`, `qemu-kvm`; not `qemu-img` or `qemu-ga`. */
export function isQemuSystemBinary(program: string): boolean {
	const base = program.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
	return base.startsWith('qemu-system-') || base === 'qemu-kvm';
}

export interface OptionValue {
	/** The text before the first `key=value`, e.g. `tcp:127.0.0.1:4444` or `socket`. */
	head: string;
	options: Map<string, string>;
}

/** Parses QEMU's `head,key=value,flag` option syntax (`,,` is an escaped comma). */
export function parseOptionValue(value: string): OptionValue {
	const parts: string[] = [];
	let current = '';
	for (let i = 0; i < value.length; i++) {
		if (value[i] === ',') {
			if (value[i + 1] === ',') {
				current += ',';
				i++;
			} else {
				parts.push(current);
				current = '';
			}
		} else {
			current += value[i];
		}
	}
	parts.push(current);
	const options = new Map<string, string>();
	let head = '';
	parts.forEach((part, index) => {
		const eq = part.indexOf('=');
		if (eq > 0) options.set(part.slice(0, eq), part.slice(eq + 1));
		else if (index === 0) head = part;
		else if (part) options.set(part, '');
	});
	return { head, options };
}

/** `2048`, `2G`, `512M`, `size=2048` forms of `-m` → MB. */
export function parseMemory(value: string): number | undefined {
	const parsed = parseOptionValue(value);
	const text = parsed.options.get('size') ?? parsed.head;
	const match = /^(\d+(?:\.\d+)?)([kKmMgGtT]?)/.exec(text);
	if (!match) return undefined;
	const n = Number(match[1]);
	switch (match[2]!.toLowerCase()) {
		case 'k':
			return Math.round(n / 1024);
		case 'g':
			return Math.round(n * 1024);
		case 't':
			return Math.round(n * 1024 * 1024);
		default:
			return Math.round(n);
	}
}

function parseSmp(value: string): number | undefined {
	const parsed = parseOptionValue(value);
	const n = Number(parsed.options.get('cpus') ?? parsed.head);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `tcp:127.0.0.1:4444,server`, `unix:/path/qmp.sock,server`, `127.0.0.1:4444` → endpoint. */
export function parseMonitorAddress(value: string): QmpEndpoint | undefined {
	const { head } = parseOptionValue(value);
	const unix = /^unix:(.+)$/.exec(head);
	if (unix) return { socket: unix[1] };
	const tcp = /^(?:tcp:)?([^:]*):(\d+)$/.exec(head);
	if (tcp) return { host: tcp[1] || '127.0.0.1', port: Number(tcp[2]) };
	return undefined;
}

function chardevEndpoint(options: Map<string, string>): QmpEndpoint | undefined {
	// `fd=` sockets (libvirt) are inherited descriptors nobody else can open.
	if (options.has('fd')) return undefined;
	const path = options.get('path');
	if (path) return { socket: path };
	const port = Number(options.get('port'));
	if (Number.isInteger(port) && port > 0) return { host: options.get('host') || '127.0.0.1', port };
	return undefined;
}

/** `-vnc 127.0.0.1:1` / `:0` → TCP port; `unix:` and `none` have none. */
export function parseVnc(value: string): number | undefined {
	const { head } = parseOptionValue(value);
	const match = /^(?:[^:]*):(\d+)$/.exec(head);
	if (!match) return undefined;
	// `host:N` is display N, i.e. TCP port 5900 + N.
	return 5900 + Number(match[1]);
}

function diskFile(value: string): { file?: string; cdrom: boolean } {
	const { head, options } = parseOptionValue(value);
	const file = options.get('file') ?? (options.size === 0 || !head.includes('=') ? head || undefined : undefined);
	const media = options.get('media');
	return { file: file || undefined, cdrom: media === 'cdrom' || /\.iso$/i.test(file ?? '') };
}

/** Builds an `ExternalVm` from a process, or `undefined` when it is not a QEMU system emulator. */
export function parseQemuCommand(entry: ProcessEntry): ExternalVm | undefined {
	const argv = splitArgs(entry.command);
	if (!argv[0] || !isQemuSystemBinary(argv[0])) return undefined;
	const vm: ExternalVm = { pid: entry.pid, binary: argv[0], name: `qemu-${entry.pid}`, cpus: 1, memoryMB: 128, disks: [], command: entry.command };
	const chardevs = new Map<string, QmpEndpoint | undefined>();
	let monitorChardev: string | undefined;
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i]!.replace(/^--/, '-');
		const value = argv[i + 1];
		if (value === undefined) break;
		switch (arg) {
			case '-name': {
				const { head, options } = parseOptionValue(value);
				vm.name = options.get('guest') ?? head ?? vm.name;
				break;
			}
			case '-m':
				vm.memoryMB = parseMemory(value) ?? vm.memoryMB;
				break;
			case '-smp':
				vm.cpus = parseSmp(value) ?? vm.cpus;
				break;
			case '-machine':
			case '-M':
				vm.machine = parseOptionValue(value).head || vm.machine;
				break;
			case '-hda':
			case '-hdb':
				vm.disks.push(value);
				break;
			case '-cdrom':
				vm.cdrom = value;
				break;
			case '-drive': {
				const drive = diskFile(value);
				if (drive.file) {
					if (drive.cdrom) vm.cdrom ??= drive.file;
					else if (!parseOptionValue(value).options.get('if')?.startsWith('pflash')) vm.disks.push(drive.file);
				}
				break;
			}
			case '-qmp':
			case '-qmp-pretty':
				vm.qmp ??= parseMonitorAddress(value);
				break;
			case '-chardev': {
				const { head, options } = parseOptionValue(value);
				if (head === 'socket' || options.get('backend') === 'socket') {
					const id = options.get('id');
					if (id) chardevs.set(id, chardevEndpoint(options));
				}
				break;
			}
			case '-mon': {
				const { options } = parseOptionValue(value);
				if (options.get('mode') !== 'readline') monitorChardev ??= options.get('chardev');
				break;
			}
			case '-vnc':
				vm.vncPort = parseVnc(value);
				break;
			default:
				continue;
		}
		i++;
	}
	if (!vm.qmp && monitorChardev) vm.qmp = chardevs.get(monitorChardev);
	return vm;
}

/** All QEMU VMs in a process list, minus the ones in `exclude` (the pids this extension manages). */
export function findExternalVms(processes: readonly ProcessEntry[], exclude: ReadonlySet<number> = new Set()): ExternalVm[] {
	return processes
		.filter((p) => !exclude.has(p.pid))
		.map(parseQemuCommand)
		.filter((vm): vm is ExternalVm => !!vm);
}
