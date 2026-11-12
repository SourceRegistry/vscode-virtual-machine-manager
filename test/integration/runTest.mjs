// Launches an isolated VS Code (downloaded into .vscode-test) with the core and the Hyper-V and QEMU
// provider extensions in development mode and runs suite.cjs inside its extension host.
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const userData = mkdtempSync(path.join(os.tmpdir(), 'vmm-test-'));

/**
 * The VS Code to test in. The update server sometimes times out on CI runners (ETIMEDOUT while
 * "Resolving version..."), so a failed lookup or download is tried again before the run fails.
 * With a cached build in .vscode-test, a failed lookup falls back to it by itself.
 */
async function vscodeExecutable() {
	const waits = [5_000, 15_000, 30_000];
	for (let attempt = 0; ; attempt++) {
		try {
			return await downloadAndUnzipVSCode({ timeout: 30_000 });
		} catch (error) {
			if (attempt >= waits.length) throw error;
			console.warn(`Could not get VS Code (${error?.code ?? error?.message ?? error}); trying again in ${waits[attempt] / 1000} s`);
			await delay(waits[attempt]);
		}
	}
}

// Set VSCODE_EXECUTABLE_PATH to use an installed VS Code instead of downloading one, e.g.
// "/Applications/Visual Studio Code.app/Contents/MacOS/Code". It still runs in an isolated profile.
await runTests({
	vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || (await vscodeExecutable()),
	extensionDevelopmentPath: [root, path.join(root, 'extensions', 'hyperv'), path.join(root, 'extensions', 'qemu')],
	extensionTestsPath: path.join(root, 'test', 'integration', 'suite.cjs'),
	launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome']
});
