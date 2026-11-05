/** Turning files found in a folder into importable VMs. Pure module, unit tested. */
import * as path from 'node:path';

export const DISK_EXTENSIONS = ['qcow2', 'qcow', 'raw', 'img', 'vmdk', 'vdi', 'vhdx', 'vhd', 'qed'] as const;

/** QEMU `format=` for a disk file, from its extension (`raw` when unknown). */
export function diskFormat(file: string): string {
	switch (path.extname(file).toLowerCase().slice(1)) {
		case 'qcow2':
			return 'qcow2';
		case 'qcow':
			return 'qcow';
		case 'vmdk':
			return 'vmdk';
		case 'vdi':
			return 'vdi';
		case 'vhdx':
			return 'vhdx';
		case 'vhd':
			return 'vpc';
		case 'qed':
			return 'qed';
		default:
			return 'raw';
	}
}

export function classifyFile(file: string): 'disk' | 'iso' | undefined {
	const ext = path.extname(file).toLowerCase().slice(1);
	if (ext === 'iso') return 'iso';
	return (DISK_EXTENSIONS as readonly string[]).includes(ext) ? 'disk' : undefined;
}

export interface LibvirtDomain {
	name: string;
	memoryMB?: number;
	cpus?: number;
	disks: string[];
	cdrom?: string;
	uefi?: boolean;
	/** Guest architecture as libvirt spells it (`x86_64`, `aarch64`, `i686`…). */
	arch?: string;
}

const UNIT_TO_KIB: Record<string, number> = { b: 1 / 1024, bytes: 1 / 1024, kb: 1000 / 1024, k: 1, kib: 1, mb: 1000 ** 2 / 1024, m: 1024, mib: 1024, gb: 1000 ** 3 / 1024, g: 1024 ** 2, gib: 1024 ** 2, tb: 1000 ** 4 / 1024, t: 1024 ** 3, tib: 1024 ** 3 };

function attr(tag: string, name: string): string | undefined {
	return new RegExp(`\\b${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)")`).exec(tag)?.slice(1).find((v) => v !== undefined);
}

function decodeXml(text: string): string {
	return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** The parts of a libvirt domain XML a QEMU VM needs. `undefined` when the text is not a domain. */
export function parseLibvirtXml(xml: string): LibvirtDomain | undefined {
	if (!/<domain\b/.test(xml)) return undefined;
	const name = /<name>([^<]+)<\/name>/.exec(xml)?.[1];
	if (!name) return undefined;
	let memoryMB: number | undefined;
	// The maximum (`memory`) is the configured size; `currentMemory` is only the balloon's current target.
	const memory = /<memory\b([^>]*)>\s*(\d+)\s*<\/memory>/.exec(xml) ?? /<currentMemory\b([^>]*)>\s*(\d+)\s*<\/currentMemory>/.exec(xml);
	if (memory) {
		const unit = (attr(memory[1]!, 'unit') ?? 'KiB').toLowerCase();
		memoryMB = Math.max(1, Math.round((Number(memory[2]) * (UNIT_TO_KIB[unit] ?? 1)) / 1024));
	}
	const vcpu = /<vcpu\b[^>]*>\s*(\d+)\s*<\/vcpu>/.exec(xml);
	const domain: LibvirtDomain = { name: decodeXml(name).trim(), memoryMB, cpus: vcpu ? Number(vcpu[1]) : undefined, disks: [] };
	for (const disk of xml.matchAll(/<disk\b([^>]*)>([\s\S]*?)<\/disk>/g)) {
		const device = attr(disk[1]!, 'device') ?? 'disk';
		const file = /<source\b([^>]*)>/.exec(disk[2]!);
		const source = file ? (attr(file[1]!, 'file') ?? attr(file[1]!, 'dev')) : undefined;
		if (!source) continue;
		if (device === 'cdrom') domain.cdrom ??= decodeXml(source);
		else if (device === 'disk') domain.disks.push(decodeXml(source));
	}
	domain.arch = /<type\b[^>]*\barch\s*=\s*['"]([^'"]+)['"]/.exec(xml)?.[1];
	domain.uefi = /<os\b[^>]*firmware\s*=\s*['"]efi['"]/.test(xml) || /<loader\b[^>]*type\s*=\s*['"]pflash['"]/.test(xml);
	return domain;
}

export type ImportSource = 'vm.json' | 'libvirt' | 'utm' | 'image';

/** A VM that can be created from files already on disk. */
export interface FolderCandidate {
	/** Stable per scan: the path that defines it. */
	id: string;
	name: string;
	source: ImportSource;
	disks: string[];
	cdrom?: string;
	cpus?: number;
	memoryMB?: number;
	uefi?: boolean;
	arch?: string;
}

export interface FolderInput {
	/** Every file found (absolute paths). */
	files: string[];
	/** Contents of the `*.xml` files that look like libvirt domains. */
	libvirt: ReadonlyMap<string, string>;
	/** Parsed `vm.json` files of VMs managed by another copy of this extension. */
	vmJson: ReadonlyMap<string, { name?: string; cpus?: number; memoryMB?: number; disks?: string[]; cdrom?: string; firmware?: string; arch?: string }>;
}

/**
 * Groups the files of a folder into VMs: a definition (vm.json, libvirt XML) wins over loose disk
 * images; each remaining disk image is a VM of its own (UTM `*.utm` bundles are named after the
 * bundle), with the ISO beside it as CD when there is exactly one.
 */
export function candidatesFromFolder(input: FolderInput): FolderCandidate[] {
	const result: FolderCandidate[] = [];
	const used = new Set<string>();
	const resolve = (base: string, file: string) => (path.isAbsolute(file) ? file : path.join(path.dirname(base), file));

	for (const [file, json] of input.vmJson) {
		const disks = (json.disks ?? []).map((d) => resolve(file, d));
		disks.forEach((d) => used.add(d));
		result.push({
			id: file,
			name: json.name ?? path.basename(path.dirname(file)),
			source: 'vm.json',
			disks,
			cdrom: json.cdrom ? resolve(file, json.cdrom) : undefined,
			cpus: json.cpus,
			memoryMB: json.memoryMB,
			uefi: json.firmware === 'uefi',
			arch: json.arch
		});
	}
	for (const [file, xml] of input.libvirt) {
		const domain = parseLibvirtXml(xml);
		if (!domain) continue;
		domain.disks.forEach((d) => used.add(d));
		result.push({ id: file, name: domain.name, source: 'libvirt', disks: domain.disks, cdrom: domain.cdrom, cpus: domain.cpus, memoryMB: domain.memoryMB, uefi: domain.uefi, arch: domain.arch });
	}

	const isos = input.files.filter((f) => classifyFile(f) === 'iso');
	for (const file of input.files.filter((f) => classifyFile(f) === 'disk' && !used.has(f)).sort()) {
		const dir = path.dirname(file);
		const bundle = dir.split(path.sep).reverse().find((part) => part.toLowerCase().endsWith('.utm'));
		const beside = isos.filter((iso) => path.dirname(iso) === dir);
		result.push({
			id: file,
			name: bundle ? bundle.replace(/\.utm$/i, '') : path.basename(file, path.extname(file)),
			source: bundle ? 'utm' : 'image',
			disks: [file],
			cdrom: beside.length === 1 ? beside[0] : undefined
		});
	}
	return result;
}
