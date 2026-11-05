// Publishes the packaged extensions (out/<name>-<version>.vsix, made by scripts/package.mjs) to the
// VS Code Marketplace with trusted publishing: `vsce --oidc` exchanges the GitHub Actions OIDC token
// for a short-lived Marketplace credential, so no personal access token is stored anywhere.
//
// Runs in .github/workflows/release.yml (the workflow named in the publisher's Trusted Publishing
// policy). Without arguments the core goes first because the providers declare it as an extension dependency.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findPackage, packages, root, vsixPath } from './packages.mjs';

const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
// `node scripts/publish.mjs qemu` publishes one extension (by id or release tag), no argument all of them.
const only = process.argv[2];

const files = (only ? [findPackage(only)] : packages).map((pkg) => {
	const file = vsixPath(pkg);
	if (!existsSync(file)) throw new Error(`Missing package ${path.relative(root, file)}: run "npm run package" first.`);
	return file;
});

for (const file of files) {
	console.log(`Publishing ${path.relative(root, file)}…`);
	// --skip-duplicate: re-running a release after a partial failure only publishes what is missing.
	execFileSync(process.execPath, [vsce, 'publish', '--oidc', '--packagePath', file, '--skip-duplicate'], {
		cwd: root,
		stdio: 'inherit'
	});
}
