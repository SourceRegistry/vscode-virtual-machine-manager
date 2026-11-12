import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIso, isoName } from '../src/provisioning/iso9660';

const SECTOR = 2048;

/** A reader written from the spec, independent of the writer's helpers. */
function readTree(iso: Buffer, sector: number): { volumeId: string; files: Map<string, Buffer> } {
	const vd = iso.subarray(sector * SECTOR, (sector + 1) * SECTOR);
	expect(vd.subarray(1, 6).toString('ascii')).toBe('CD001');
	const joliet = vd[0] === 2;
	const volumeId = joliet
		? Buffer.from(vd.subarray(40, 72)).swap16().toString('utf16le').trim()
		: vd.subarray(40, 72).toString('latin1').trim();
	const rootExtent = vd.readUInt32LE(156 + 2);
	const rootSize = vd.readUInt32LE(156 + 10);
	const dir = iso.subarray(rootExtent * SECTOR, rootExtent * SECTOR + rootSize);
	const files = new Map<string, Buffer>();
	for (let offset = 0; offset < dir.length; ) {
		const length = dir[offset]!;
		if (!length) break;
		const flags = dir[offset + 25]!;
		const idLength = dir[offset + 32]!;
		const id = dir.subarray(offset + 33, offset + 33 + idLength);
		const extent = dir.readUInt32LE(offset + 2);
		const size = dir.readUInt32LE(offset + 10);
		if (!(flags & 2)) {
			const name = joliet ? Buffer.from(id).swap16().toString('utf16le') : id.toString('ascii');
			files.set(name, Buffer.from(iso.subarray(extent * SECTOR, extent * SECTOR + size)));
		}
		offset += length;
	}
	return { volumeId, files };
}

const DATE = new Date(Date.UTC(2026, 10, 10, 12, 0, 0));

describe('isoName', () => {
	it('makes uppercase 8.3 names with a version, and keeps them unique', () => {
		const taken = new Set<string>();
		expect(isoName('user-data', taken)).toBe('USER_DAT.;1');
		expect(isoName('user-data2', taken)).toBe('USER_DAT.;1'.replace('USER_DAT', 'USER_DA1'));
		expect(isoName('meta-data', taken)).toBe('META_DAT.;1');
		expect(isoName('network-config.yaml', taken)).toBe('NETWORK_.YAM;1');
	});
});

describe('buildIso', () => {
	const files = [
		{ name: 'user-data', data: Buffer.from('#cloud-config\nhostname: x\n') },
		{ name: 'meta-data', data: Buffer.from('instance-id: vmm-1\n') },
		{ name: 'big-file.bin', data: Buffer.alloc(5000, 7) },
		{ name: 'empty', data: Buffer.alloc(0) }
	];
	const iso = buildIso(files, { volumeId: 'cidata', date: DATE });

	it('is a whole number of sectors with the descriptors where ECMA-119 puts them', () => {
		expect(iso.length % SECTOR).toBe(0);
		expect(iso[16 * SECTOR]).toBe(1);
		expect(iso[17 * SECTOR]).toBe(2);
		expect(iso[18 * SECTOR]).toBe(255);
		expect(iso.subarray(17 * SECTOR + 88, 17 * SECTOR + 91).toString()).toBe('%/E');
		expect(iso.readUInt32LE(16 * SECTOR + 80)).toBe(iso.length / SECTOR);
		expect(iso.readUInt32BE(16 * SECTOR + 84)).toBe(iso.length / SECTOR);
	});

	it('names the volume cidata in both trees', () => {
		expect(readTree(iso, 16).volumeId).toBe('cidata');
		expect(readTree(iso, 17).volumeId).toBe('cidata');
	});

	it('holds every file, byte for byte, under its real name in the Joliet tree', () => {
		const joliet = readTree(iso, 17).files;
		expect([...joliet.keys()].sort()).toEqual(['big-file.bin', 'empty', 'meta-data', 'user-data']);
		for (const file of files) expect(joliet.get(file.name)!.equals(file.data), file.name).toBe(true);
	});

	it('holds the same files under 8.3 names in the plain tree', () => {
		const plain = readTree(iso, 16).files;
		expect(plain.get('USER_DAT.;1')!.toString()).toBe('#cloud-config\nhostname: x\n');
		expect(plain.get('META_DAT.;1')!.toString()).toBe('instance-id: vmm-1\n');
		expect(plain.get('BIG_FILE.BIN;1')!.length).toBe(5000);
	});

	it('is reproducible', () => {
		expect(buildIso(files, { volumeId: 'cidata', date: DATE }).equals(iso)).toBe(true);
	});

	it('refuses names it cannot store and too many files', () => {
		expect(() => buildIso([{ name: 'a/b', data: Buffer.alloc(0) }], { volumeId: 'x' })).toThrow(/not a valid file name/);
		expect(() => buildIso([{ name: '', data: Buffer.alloc(0) }], { volumeId: 'x' })).toThrow();
		expect(() => buildIso([{ name: 'a', data: Buffer.alloc(0) }, { name: 'a', data: Buffer.alloc(0) }], { volumeId: 'x' })).toThrow(/Duplicate/);
		const many = Array.from({ length: 80 }, (_, i) => ({ name: `file-number-${i}.txt`, data: Buffer.alloc(1) }));
		expect(() => buildIso(many, { volumeId: 'x' })).toThrow(/Too many files/);
	});

	// libarchive (bsdtar, also macOS' tar) reads real ISO images: an outside opinion on the layout.
	it('is read by an independent tool', () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-iso-')), 'seed.iso');
		fs.writeFileSync(file, iso);
		let listing: string;
		try {
			listing = execFileSync('bsdtar', ['-tf', file], { encoding: 'utf8' });
		} catch {
			try {
				listing = execFileSync('tar', ['-tf', file], { encoding: 'utf8' });
			} catch {
				return; // no libarchive here
			}
		}
		if (!/user-data|USER_DAT/i.test(listing)) return; // a GNU tar, which cannot read ISOs
		expect(listing).toContain('user-data');
		expect(listing).toContain('meta-data');
		fs.rmSync(path.dirname(file), { recursive: true, force: true });
	});
});
