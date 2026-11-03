// Packages the core extension and every provider extension into ./out/*.vsix.
// Each provider is its own Marketplace extension; all of them share one version (see .releaserc.json).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out');
mkdirSync(out, { recursive: true });
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const only = process.argv[2];

const targets = [root, ...readdirSync(path.join(root, 'extensions')).map((d) => path.join(root, 'extensions', d))].filter(
	(dir) => existsSync(path.join(dir, 'package.json')) && (!only || path.basename(dir) === only || (only === 'core' && dir === root))
);

for (const dir of targets) {
	// Providers ship the shared licence and changelog (all extensions are released together).
	if (dir !== root) {
		copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));
		copyFileSync(path.join(root, 'CHANGELOG.md'), path.join(dir, 'CHANGELOG.md'));
	}
	console.log(`Packaging ${path.relative(root, dir) || 'core'}…`);
	execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--skip-license', '--out', out], {
		cwd: dir,
		stdio: 'inherit'
	});
}
