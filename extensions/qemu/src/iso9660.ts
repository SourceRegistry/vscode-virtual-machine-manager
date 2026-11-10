/**
 * A minimal ISO 9660 image writer with Joliet names, for the small `cidata` disk cloud-init reads
 * (a handful of files in one flat directory). Joliet carries the real, long, mixed-case names; the plain ISO
 * names are a fallback. Pure, unit tested; the layout is documented in ECMA-119.
 */

const SECTOR = 2048;

export interface IsoFile {
	name: string;
	data: Buffer;
}

export interface IsoOptions {
	/** The volume label; cloud-init looks for `cidata`. */
	volumeId: string;
	/** Defaults to now; fixed in tests so the output is reproducible. */
	date?: Date;
}

function both32(value: number): Buffer {
	const b = Buffer.alloc(8);
	b.writeUInt32LE(value, 0);
	b.writeUInt32BE(value, 4);
	return b;
}

function both16(value: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeUInt16LE(value, 0);
	b.writeUInt16BE(value, 2);
	return b;
}

/** Seven-byte recording date of a directory record. */
function recordDate(date: Date): Buffer {
	return Buffer.from([date.getUTCFullYear() - 1900, date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), 0]);
}

/** Seventeen-character date of a volume descriptor (`YYYYMMDDHHMMSS` + hundredths + zone). */
function volumeDate(date: Date): Buffer {
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	const text = `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}00`;
	return Buffer.concat([Buffer.from(text, 'ascii'), Buffer.from([0])]);
}

function pad(text: string, length: number, ucs2: boolean): Buffer {
	if (!ucs2) return Buffer.from(text.slice(0, length).padEnd(length, ' '), 'latin1');
	const chars = length / 2;
	const b = Buffer.alloc(length);
	const value = text.slice(0, chars).padEnd(chars, ' ');
	for (let i = 0; i < chars; i++) b.writeUInt16BE(value.charCodeAt(i), i * 2);
	return b;
}

function ucs2(text: string): Buffer {
	const b = Buffer.alloc(text.length * 2);
	for (let i = 0; i < text.length; i++) b.writeUInt16BE(text.charCodeAt(i), i * 2);
	return b;
}

/** `user-data` → `USER_DAT.;1`: uppercase d-characters, 8.3, unique. */
export function isoName(name: string, taken: Set<string>): string {
	const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
	const dot = name.lastIndexOf('.');
	const base = clean(dot > 0 ? name.slice(0, dot) : name);
	const ext = dot > 0 ? clean(name.slice(dot + 1)).slice(0, 3) : '';
	for (let n = 0; ; n++) {
		const suffix = n ? String(n) : '';
		const candidate = `${base.slice(0, 8 - suffix.length)}${suffix}.${ext};1`;
		if (!taken.has(candidate)) {
			taken.add(candidate);
			return candidate;
		}
	}
}

function record(extent: number, size: number, flags: number, id: Buffer, date: Buffer): Buffer {
	const length = 33 + id.length + (id.length % 2 === 0 ? 1 : 0);
	const b = Buffer.alloc(length);
	b[0] = length;
	both32(extent).copy(b, 2);
	both32(size).copy(b, 10);
	date.copy(b, 18);
	b[25] = flags;
	both16(1).copy(b, 28);
	b[32] = id.length;
	id.copy(b, 33);
	return b;
}

interface Entry {
	id: Buffer;
	extent: number;
	size: number;
	flags: number;
}

function directory(self: number, parent: number, entries: Entry[], date: Buffer): Buffer {
	const records = [
		record(self, SECTOR, 2, Buffer.from([0]), date),
		record(parent, SECTOR, 2, Buffer.from([1]), date),
		...[...entries]
			.sort((a, b) => Buffer.compare(a.id, b.id))
			.map((e) => record(e.extent, e.size, e.flags, e.id, date))
	];
	const body = Buffer.concat(records);
	if (body.length > SECTOR) throw new Error('Too many files for the image directory');
	return Buffer.concat([body, Buffer.alloc(SECTOR - body.length)]);
}

function pathTable(extent: number, littleEndian: boolean): Buffer {
	const b = Buffer.alloc(10);
	b[0] = 1;
	if (littleEndian) {
		b.writeUInt32LE(extent, 2);
		b.writeUInt16LE(1, 6);
	} else {
		b.writeUInt32BE(extent, 2);
		b.writeUInt16BE(1, 6);
	}
	return b;
}

function descriptor(kind: 'primary' | 'joliet', o: { volumeId: string; sectors: number; pathLE: number; pathBE: number; root: Buffer; date: Date }): Buffer {
	const joliet = kind === 'joliet';
	const b = Buffer.alloc(SECTOR);
	b[0] = joliet ? 2 : 1;
	b.write('CD001', 1, 'ascii');
	b[6] = 1;
	pad('', 32, joliet).copy(b, 8);
	pad(o.volumeId, 32, joliet).copy(b, 40);
	both32(o.sectors).copy(b, 80);
	if (joliet) b.write('%/E', 88, 'ascii');
	both16(1).copy(b, 120);
	both16(1).copy(b, 124);
	both16(SECTOR).copy(b, 128);
	both32(10).copy(b, 132);
	b.writeUInt32LE(o.pathLE, 140);
	b.writeUInt32BE(o.pathBE, 148);
	o.root.copy(b, 156);
	for (const offset of [190, 318, 446, 574]) pad('', 128, joliet).copy(b, offset);
	for (const offset of [702, 739, 776]) pad('', 37, joliet).copy(b, offset);
	volumeDate(o.date).copy(b, 813);
	volumeDate(o.date).copy(b, 830);
	Buffer.from('0000000000000000\0', 'ascii').copy(b, 847);
	volumeDate(o.date).copy(b, 864);
	b[881] = 1;
	return b;
}

/** Builds the image. File names are kept as given in the Joliet tree (at most 64 characters). */
export function buildIso(files: IsoFile[], options: IsoOptions): Buffer {
	const date = options.date ?? new Date();
	const when = recordDate(date);
	for (const file of files) if (file.name.length > 64 || /[\\/;*?"<>|:]/.test(file.name) || !file.name) throw new Error(`"${file.name}" is not a valid file name for the image`);
	if (new Set(files.map((f) => f.name)).size !== files.length) throw new Error('Duplicate file name');

	// Sectors: 16 primary, 17 Joliet, 18 terminator, 19-22 path tables, 23 / 24 directories, then data.
	const FIRST_DATA = 25;
	let next = FIRST_DATA;
	const extents = files.map((f) => {
		const extent = next;
		next += Math.max(1, Math.ceil(f.data.length / SECTOR));
		return extent;
	});
	const total = next;

	const taken = new Set<string>();
	const isoEntries: Entry[] = files.map((f, i) => ({ id: Buffer.from(isoName(f.name, taken), 'ascii'), extent: extents[i]!, size: f.data.length, flags: 0 }));
	const jolietEntries: Entry[] = files.map((f, i) => ({ id: ucs2(f.name), extent: extents[i]!, size: f.data.length, flags: 0 }));

	const out = Buffer.alloc(total * SECTOR);
	const put = (sector: number, data: Buffer) => data.copy(out, sector * SECTOR);

	put(16, descriptor('primary', { volumeId: options.volumeId, sectors: total, pathLE: 19, pathBE: 20, root: record(23, SECTOR, 2, Buffer.from([0]), when), date }));
	put(17, descriptor('joliet', { volumeId: options.volumeId, sectors: total, pathLE: 21, pathBE: 22, root: record(24, SECTOR, 2, Buffer.from([0]), when), date }));
	const terminator = Buffer.alloc(SECTOR);
	terminator[0] = 255;
	terminator.write('CD001', 1, 'ascii');
	terminator[6] = 1;
	put(18, terminator);
	put(19, pathTable(23, true));
	put(20, pathTable(23, false));
	put(21, pathTable(24, true));
	put(22, pathTable(24, false));
	put(23, directory(23, 23, isoEntries, when));
	put(24, directory(24, 24, jolietEntries, when));
	files.forEach((f, i) => put(extents[i]!, f.data));
	return out;
}
