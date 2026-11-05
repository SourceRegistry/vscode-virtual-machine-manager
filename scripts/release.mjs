// Releases every package that has releasable commits since its own last tag, one after the other
// (core first). Extra arguments, e.g. --dry-run, are passed on to semantic-release.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { packages, root } from './packages.mjs';

const bin = path.join(root, 'node_modules', 'semantic-release', 'bin', 'semantic-release.js');
const failed = [];

for (const pkg of packages) {
	console.log(`\n=== ${pkg.displayName ?? pkg.name} (${pkg.id}) ===`);
	const { status } = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
		cwd: root,
		stdio: 'inherit',
		env: { ...process.env, RELEASE_PACKAGE: pkg.id }
	});
	if (status === 0) continue;
	failed.push(pkg.id);
	// Providers need the core on the Marketplace; do not release them against a failed core release.
	if (pkg.id === 'core') break;
}

if (failed.length) {
	console.error(`\nRelease failed for: ${failed.join(', ')}`);
	process.exit(1);
}
