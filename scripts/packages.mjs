// The extensions this repository releases, each on its own version and tag.
//
// `core` is the VM Manager extension at the repository root; every directory in extensions/ is a
// provider extension. A commit counts towards a package's next version when it touches one of the
// package's `paths` (and none only of `exclude`); see scripts/release/scoped.mjs.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readManifest = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));

/** Providers bundle packages/sdk, so a change there is a change of every provider. */
const SHARED_BY_PROVIDERS = ['packages/sdk/'];

const providers = readdirSync(path.join(root, 'extensions'))
	.filter((d) => existsSync(path.join(root, 'extensions', d, 'package.json')))
	.sort()
	.map((d) => {
		const dir = path.join(root, 'extensions', d);
		const { name, displayName } = readManifest(dir);
		return {
			id: d,
			dir,
			name,
			displayName,
			// The legacy lockstep tags were `v1.2.3`; each provider now has `<name>-v1.2.3`.
			tagFormat: `${name}-v\${version}`,
			changelog: `extensions/${d}/CHANGELOG.md`,
			paths: [`extensions/${d}/`, ...SHARED_BY_PROVIDERS],
			exclude: []
		};
	});

const core = readManifest(root);

/** Core first: providers depend on it, so it must be on the Marketplace before they are. */
export const packages = [
	{
		id: 'core',
		dir: root,
		name: core.name,
		displayName: core.displayName,
		tagFormat: 'v${version}',
		changelog: 'CHANGELOG.md',
		paths: [''],
		exclude: ['extensions/']
	},
	...providers
];

/** Finds a package by its id (`core`, `qemu`, …) or by one of its release tags (`v1.2.3`, `vm-manager-qemu-v1.2.3`). */
export function findPackage(idOrTag) {
	const byId = packages.find((p) => p.id === idOrTag);
	if (byId) return byId;
	const byTag = packages.find((p) => {
		const [prefix, suffix] = p.tagFormat.split('${version}');
		return idOrTag.startsWith(prefix) && idOrTag.endsWith(suffix) && /^\d/.test(idOrTag.slice(prefix.length));
	});
	if (!byTag) throw new Error(`Unknown package or release tag "${idOrTag}"`);
	return byTag;
}

/** Whether a commit that changed `files` belongs to a package. */
export function touchesPackage(files, { paths, exclude = [] }) {
	const within = (file, prefixes) => prefixes.some((p) => p === '' || file === p || file.startsWith(p));
	return files.some((file) => within(file, paths) && !within(file, exclude.filter((p) => p !== '')));
}

/**
 * The esbuild bundle of every package, keyed by package id. Paths are relative to the repository root;
 * `main` in each package.json must point at `out`.
 */
export function buildTargets() {
	return Object.fromEntries(
		packages.map((p) => {
			const dir = path.relative(root, p.dir);
			const entry = p.id === 'core' ? 'src/extension/extension.ts' : path.join(dir, 'src', 'extension.ts');
			return [p.id, { entry: entry.split(path.sep).join('/'), out: path.join(dir, 'dist', 'extension.js').split(path.sep).join('/') }];
		})
	);
}

/** The tsconfig of every package, for the type check (`npm run check`). */
export const tsconfigs = () =>
	packages.map((p) => path.join(path.relative(root, p.dir), 'tsconfig.json').split(path.sep).join('/'));

export const vsixPath =(pkg, version) => path.join(root, 'out', `${pkg.name}-${version ?? readManifest(pkg.dir).version}.vsix`);
export const manifestVersion = (pkg) => readManifest(pkg.dir).version;
