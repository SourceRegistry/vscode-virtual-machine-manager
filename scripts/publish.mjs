// Publishes the packaged extensions (out/<name>-<version>.vsix, made by scripts/package.mjs) to the
// VS Code Marketplace with trusted publishing: `vsce --oidc` exchanges the GitHub Actions OIDC token
// for a short-lived Marketplace credential, so no personal access token is stored anywhere.
//
// Runs in .github/workflows/release.yml (the workflow named in the publisher's Trusted Publishing
// policy). The core goes first because the providers declare it as an extension dependency.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const manifest = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));

const dirs = [
	root,
	...readdirSync(path.join(root, 'extensions'))
		.map((d) => path.join(root, 'extensions', d))
		.filter((dir) => existsSync(path.join(dir, 'package.json')))
];

const packages = dirs.map((dir) => {
	const { name, version } = manifest(dir);
	const file = path.join(root, 'out', `${name}-${version}.vsix`);
	if (!existsSync(file)) throw new Error(`Missing package ${path.relative(root, file)}: run "npm run package" first.`);
	return file;
});

for (const file of packages) {
	console.log(`Publishing ${path.relative(root, file)}…`);
	// --skip-duplicate: re-running a release after a partial failure only publishes what is missing.
	execFileSync(process.execPath, [vsce, 'publish', '--oidc', '--packagePath', file, '--skip-duplicate'], {
		cwd: root,
		stdio: 'inherit'
	});
}
