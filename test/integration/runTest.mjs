// Launches an isolated VS Code (downloaded into .vscode-test) with the core and both provider
// extensions in development mode and runs suite.cjs inside its extension host.
import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const userData = mkdtempSync(path.join(os.tmpdir(), 'vmm-test-'));

await runTests({
	extensionDevelopmentPath: [root, path.join(root, 'extensions', 'hyperv'), path.join(root, 'extensions', 'qemu')],
	extensionTestsPath: path.join(root, 'test', 'integration', 'suite.cjs'),
	launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome']
});
