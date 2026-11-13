// Smoke test executed inside the VS Code extension host (see runTest.mjs).
const assert = require('node:assert/strict');
const vscode = require('vscode');

const CORE = 'sourceregistry.vm-manager';

async function run() {
	const core = vscode.extensions.getExtension(CORE);
	assert.ok(core, 'core extension is installed');
	const api = await core.activate();
	assert.equal(api.apiVersion, 1, 'API version');

	// Providers activate lazily; activating them registers their providers with the core.
	for (const id of ['sourceregistry.vm-manager-hyperv', 'sourceregistry.vm-manager-qemu']) {
		const ext = vscode.extensions.getExtension(id);
		assert.ok(ext, `${id} is installed`);
		await ext.activate();
	}
	for (const id of ['hyperv', 'qemu']) {
		assert.throws(
			() => api.registerProvider({ id, displayName: id, connectionSchema: [], connect: async () => undefined }),
			/already registered/,
			`${id} provider is registered`
		);
	}

	// Every contributed command has a handler.
	const registered = new Set(await vscode.commands.getCommands(true));
	const contributed = [core, vscode.extensions.getExtension('sourceregistry.vm-manager-hyperv'), vscode.extensions.getExtension('sourceregistry.vm-manager-qemu')]
		.flatMap((ext) => ext.packageJSON.contributes.commands.map((c) => c.command));
	const missing = contributed.filter((c) => !registered.has(c));
	assert.deepEqual(missing, [], 'all contributed commands are registered');

	// Overview right-click menu mirrors the tree menu (same commands, same state rules).
	const menus = core.packageJSON.contributes.menus;
	// Group rows (the user's groups) only exist in the tree.
	// Multi-selection entries only exist in the tree (the overview has its own bulk toolbar).
	const treeMenu = menus['view/item/context'].filter((m) => !m.group.startsWith('inline') && !m.when.includes('viewItem =~ /^group;') && !m.when.includes('&& listMultiSelection'));
	const webviewMenu = menus['webview/context'];
	assert.deepEqual(
		webviewMenu.map((m) => [m.command, m.when.replace('webviewId == vmm.overview && vmmItem', '')]),
		treeMenu.map((m) => [m.command, m.when.replace(/^view (==|=~) \S+ && (!listMultiSelection && )?viewItem/, '')]),
		'overview context menu matches tree context menu'
	);

	// A third-party provider can register, and its fake cluster can be driven through commands.
	const disposable = api.registerProvider({
		id: 'smoke',
		displayName: 'Smoke',
		connectionSchema: [],
		connect: async () => ({
			capabilities: { create: false, edit: false, delete: false, power: ['start'], consoles: [], preview: false, external: false },
			listNodes: async () => [{ id: 'n1', name: 'node-1', status: 'online' }],
			listVms: async () => [{ id: 'v1', name: 'vm-1', state: 'stopped' }],
			getCreateSchema: async () => [],
			createVm: async () => ({ id: 'v2', name: 'vm-2', state: 'stopped' }),
			getVmConfig: async () => ({ schema: [], values: {} }),
			updateVm: async () => undefined,
			deleteVm: async () => undefined,
			power: async () => undefined,
			openConsole: async () => {
				throw new Error('none');
			},
			dispose() {}
		})
	});
	disposable.dispose();

	// The API for other extensions (no clusters in this profile, so no machines).
	assert.ok(api.vms, 'api.vms is exported');
	assert.deepEqual(await api.vms.list(), [], 'no machines without clusters');
	assert.equal(await api.vms.get('nope'), undefined, 'an unknown machine is undefined');
	await assert.rejects(api.vms.power('nope', 'start'), /No virtual machine is called "nope"/);

	// The "vm" task provider answers (no machines, so no tasks). Running one needs a tasks.json: checked by hand.
	assert.deepEqual(await vscode.tasks.fetchTasks({ type: 'vm' }), [], 'vm task provider is registered');

	// Every declared language model tool is registered (agent mode lists it); the MCP server stays off by default.
	const declared = core.packageJSON.contributes.languageModelTools.map((t) => t.name);
	const registeredTools = new Set(vscode.lm.tools.map((t) => t.name));
	assert.deepEqual(declared.filter((name) => !registeredTools.has(name)), [], 'all language model tools are registered');
	assert.equal(vscode.workspace.getConfiguration('vmm.mcp').get('enabled'), false, 'MCP server is off by default');

	// UI surfaces open without throwing.
	await vscode.commands.executeCommand('vmm.openOverview');
	await new Promise((r) => setTimeout(r, 1500));
	const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
	assert.ok(
		tabs.some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('vmm.overview')),
		'overview webview tab is open'
	);
	await vscode.commands.executeCommand('vmm.refresh');
	console.log('VM Manager smoke test passed');
}

module.exports = { run };
