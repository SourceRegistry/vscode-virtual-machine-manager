/**
 * Checks every Hyper-V script against a real PowerShell: the syntax of each script, and the command framing
 * end to end (parameters in, JSON out, errors). Hyper-V itself is not needed, so this runs wherever PowerShell
 * is installed: Windows PowerShell on Windows (what the provider runs), `pwsh` elsewhere (GitHub's Ubuntu runners
 * have it). Skipped when neither is found.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PowerShellSession } from '../src/PowerShellSession';
import * as scripts from '../src/scripts';
import { SSPI_SCRIPTS } from '../src/sspi';

function findPowerShell(): string | undefined {
	for (const candidate of process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh']) {
		try {
			execFileSync(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$null'], { stdio: 'ignore', timeout: 30_000 });
			return candidate;
		} catch {
			// Not installed.
		}
	}
	return undefined;
}

const shell = findPowerShell();

/** Every script the provider sends, by name. */
const all: Record<string, string> = Object.fromEntries([
	...Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
	...Object.entries(SSPI_SCRIPTS).map(([name, script]) => [`SSPI_${name}`, script])
]);

describe.skipIf(!shell)(`Hyper-V scripts in PowerShell (${shell ?? 'not installed'})`, () => {
	const session = new PowerShellSession('test', undefined, shell);
	afterAll(() => session.dispose());

	it('finds the scripts', () => {
		expect(Object.keys(all).length).toBeGreaterThan(25);
	});

	it('parses every script without syntax errors', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-ps-'));
		try {
			const input = path.join(dir, 'scripts.json');
			// Parsed the way the provider runs them: a script block with `param($p)` in front.
			fs.writeFileSync(input, JSON.stringify(Object.entries(all).map(([name, script]) => ({ name, script: `param($p)\n${script}` }))));
			const check = String.raw`
$items = Get-Content -Raw -LiteralPath $args[0] | ConvertFrom-Json
foreach ($item in $items) {
	$tokens = $null; $errors = $null
	[void][System.Management.Automation.Language.Parser]::ParseInput($item.script, [ref]$tokens, [ref]$errors)
	foreach ($e in $errors) { '{0}:{1}: {2}' -f $item.name, ($e.Extent.StartLineNumber - 1), $e.Message }
}`;
			const file = path.join(dir, 'check.ps1');
			fs.writeFileSync(file, check);
			const output = execFileSync(shell!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, input], { encoding: 'utf8', timeout: 60_000 });
			expect(output.trim().split(/\r?\n/).filter(Boolean)).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 90_000);

	it('passes parameters in and objects out through the session', async () => {
		const hostile = "'; throw 'injected'; '";
		const [result] = await session.run<{ Name: string; Count: number; Items: string[] }>(
			'[pscustomobject]@{ Name = $p.name; Count = [int]$p.count + 1; Items = @($p.items) }',
			{ name: hostile, count: 41, items: ['a', 'b'] }
		);
		expect(result).toEqual({ Name: hostile, Count: 42, Items: ['a', 'b'] });
		expect(await session.run('$null')).toEqual([]);
	}, 60_000);

	// An AppLocker or WDAC policy starts PowerShell in ConstrainedLanguage mode; switching to it first does the same
	// without a policy (the machine-wide `__PSLockdownPolicy` switch would need an administrator).
	it('fails at once with the reason when PowerShell runs in ConstrainedLanguage mode', async () => {
		const locked = new PowerShellSession('locked', undefined, shell, "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'");
		try {
			const started = Date.now();
			await expect(locked.run('1 + 1', {}, 30_000)).rejects.toThrow(/ConstrainedLanguage mode/);
			await expect(locked.run('1 + 1', {}, 30_000)).rejects.toThrow(/ConstrainedLanguage mode/);
			expect(Date.now() - started).toBeLessThan(20_000);
		} finally {
			locked.dispose();
		}
	}, 60_000);

	it('turns a thrown error into a rejection and keeps the session usable', async () => {
		await expect(session.run("throw 'no such VM'")).rejects.toThrow(/no such VM/);
		expect(await session.run('1 + 1')).toEqual([2]);
	}, 60_000);
});
