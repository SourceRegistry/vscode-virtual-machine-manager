// Packages extensions into ./out/<name>-<version>.vsix. Every extension is its own Marketplace
// extension with its own version (see scripts/packages.mjs).
//
//   node scripts/package.mjs            all extensions
//   node scripts/package.mjs qemu       one extension, by id (core, hyperv, proxmox, qemu) or by release tag
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { findPackage, packages, root } from './packages.mjs';

const out = path.join(root, 'out');
mkdirSync(out, { recursive: true });
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const only = process.argv[2];

for (const pkg of only ? [findPackage(only)] : packages) {
	// Providers ship the shared licence; their changelog is their own and lives in the extension folder.
	if (pkg.id !== 'core') copyFileSync(path.join(root, 'LICENSE'), path.join(pkg.dir, 'LICENSE'));
	console.log(`Packaging ${pkg.id}…`);
	execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--skip-license', '--out', out], {
		cwd: pkg.dir,
		stdio: 'inherit'
	});
}
