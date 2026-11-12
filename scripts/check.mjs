// Type checks the core extension, every provider in extensions/ and the webview (`npm run check`).
// The list of tsconfigs comes from scripts/packages.mjs, so a new provider is checked without
// touching package.json.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, tsconfigs } from './packages.mjs';

const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const run = (name, args) => {
	console.log(`> ${name} ${args.join(' ')}`);
	// shell on Windows: .cmd shims cannot be spawned directly since Node 20.12.
	execFileSync(bin(name), args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
};

try {
	for (const tsconfig of tsconfigs()) run('tsc', ['-p', tsconfig, '--noEmit']);
	run('svelte-check', ['--tsconfig', './tsconfig.webview.json', '--threshold', 'error']);
} catch {
	process.exit(1);
}
