// Every extension this repository ships (the core and each directory in extensions/) must build,
// type check and package with its Marketplace icon. Adding a provider without its icon, its badge
// artwork or a .vscodeignore that keeps them fails here instead of on the Marketplace.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { buildTargets, packages, root, tsconfigs } from '../scripts/packages.mjs';
// @ts-expect-error plain ESM script without types
import { BADGES } from '../scripts/render-icons.mjs';

type Package = { id: string; dir: string; name: string };

const manifest = (pkg: Package) => JSON.parse(readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'));

/** Width and height from a PNG's IHDR chunk, or undefined when the file is not a PNG. */
function pngSize(file: string): { width: number; height: number } | undefined {
	const bytes = readFileSync(file);
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	if (!bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Whether `vsce package` keeps a file, by the rules @vscode/vsce applies to .vscodeignore: a file is
 * dropped when an ignore pattern (or the same pattern as a folder) matches it and no `!` pattern does.
 * package.json and README.md are always kept.
 */
function packaged(pkg: Package, file: string): boolean {
	const ignoreFile = path.join(pkg.dir, '.vscodeignore');
	const lines = existsSync(ignoreFile)
		? readFileSync(ignoreFile, 'utf8')
				.split(/[\n\r]/)
				.map((s) => s.trim())
				.filter((s) => s && !s.startsWith('#'))
		: [];
	const all = [
		...lines,
		...lines.filter((i) => !/(^|\/)[^/]*\*[^/]*$/.test(i)).map((i) => (i.endsWith('/') ? `${i}**` : `${i}/**`)),
		'!package.json',
		'!README.md'
	];
	const options = { dot: true };
	const ignored = all.filter((i) => !i.startsWith('!')).some((i) => minimatch(file, i, options));
	const kept = all.filter((i) => i.startsWith('!')).some((i) => minimatch(file, i.slice(1), options));
	return !ignored || kept;
}

const cases: [string, Package][] = packages.map((p: Package) => [p.id, p]);

describe.each(cases)('extension %s', (id, pkg) => {
	const json = manifest(pkg);

	it('has a PNG Marketplace icon of at least 128×128 px', () => {
		expect(json.icon, 'package.json needs "icon"').toBeTypeOf('string');
		const file = path.join(pkg.dir, json.icon);
		expect(existsSync(file), `${json.icon} is missing`).toBe(true);
		const size = pngSize(file);
		expect(size, `${json.icon} is not a PNG (the Marketplace rejects SVG icons)`).toBeDefined();
		expect(size!.width).toBeGreaterThanOrEqual(128);
		expect(size!.width).toBe(size!.height);
	});

	it('packages its icon, bundle and manifest', () => {
		for (const file of [json.icon, json.main.replace(/^\.\//, ''), 'package.json', 'README.md']) {
			expect(packaged(pkg, file), `.vscodeignore drops ${file}`).toBe(true);
		}
	});

	it('is bundled by esbuild.mjs to its "main"', () => {
		const target = buildTargets()[id];
		expect(target).toBeDefined();
		expect(existsSync(path.join(root, target.entry)), `${target.entry} is missing`).toBe(true);
		expect(path.join(root, target.out)).toBe(path.join(pkg.dir, json.main));
	});

	it('is type checked by npm run check', () => {
		const tsconfig = tsconfigs().find((t: string) => path.join(root, t) === path.join(pkg.dir, 'tsconfig.json'));
		expect(tsconfig && existsSync(path.join(root, tsconfig)), 'tsconfig.json is missing').toBe(true);
	});

	if (id !== 'core') {
		it('has badge artwork for scripts/render-icons.mjs', () => {
			const badge = BADGES[id];
			expect(badge, `add "${id}" to BADGES in scripts/render-icons.mjs`).toBeDefined();
			expect(existsSync(path.join(root, 'media', 'marketplace', badge.file))).toBe(true);
		});
	}
});

describe('.vscodeignore rules', () => {
	const fake = { id: 'x', dir: path.join(root, 'extensions', 'qemu'), name: 'x' };
	it('keeps whitelisted files and drops the rest', () => {
		expect(packaged(fake, 'media/icon.png')).toBe(true);
		expect(packaged(fake, 'src/extension.ts')).toBe(false);
		expect(packaged(fake, 'package.json')).toBe(true);
	});
});
