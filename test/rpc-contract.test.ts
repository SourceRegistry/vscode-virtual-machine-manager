/**
 * Every RPC method a webview view calls must be handled by the host panel that serves it; a missing
 * handler only shows up at runtime as "Unknown method" on the first click.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.resolve(__dirname, '..', file), 'utf8');

/** Methods requested by a view and its child components. */
function requested(...files: string[]): string[] {
	const methods = new Set<string>();
	for (const file of files) for (const m of read(file).matchAll(/request\(\s*'([A-Za-z]+)'/g)) methods.add(m[1]!);
	return [...methods].sort();
}

/** Handler names registered in a panel's `new WebviewChannel(…, { … })`. */
function handled(file: string): Set<string> {
	const source = read(file);
	const start = source.indexOf('new WebviewChannel');
	expect(start, `${file} creates a WebviewChannel`).toBeGreaterThan(-1);
	return new Set([...source.slice(start).matchAll(/^\t\t\t([A-Za-z]+): (?:async )?\(/gm)].map((m) => m[1]!));
}

describe.each([
	['dashboard', ['src/lib/client/views/VmDashboard.svelte'], 'src/extension/webview/VmDashboardPanel.ts'],
	['settings', ['src/lib/client/views/VmSettings.svelte', 'src/lib/client/components/SchemaForm.svelte'], 'src/extension/webview/VmSettingsPanel.ts'],
	['overview', ['src/lib/client/views/Overview.svelte'], 'src/extension/webview/OverviewPanel.ts']
])('%s', (_name, views, panel) => {
	it('has a host handler for every request the view makes', () => {
		const have = handled(panel);
		const missing = requested(...views).filter((m) => !have.has(m));
		expect(missing).toEqual([]);
	});
});

describe('dashboard command allow-list', () => {
	it('covers every command the dashboard page runs', () => {
		const allowed = new Set([...read('src/extension/webview/VmDashboardPanel.ts').matchAll(/'(vmm\.[A-Za-z]+)'/g)].map((m) => m[1]!));
		const used = [...read('src/lib/client/views/VmDashboard.svelte').matchAll(/run\('(vmm\.[A-Za-z]+)'\)/g)].map((m) => m[1]!);
		expect(used.length).toBeGreaterThan(0);
		expect(used.filter((c) => !allowed.has(c))).toEqual([]);
	});
});
