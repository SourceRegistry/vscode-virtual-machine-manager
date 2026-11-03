import * as vscode from 'vscode';
import { VMM_API_VERSION, type HypervisorProvider, type VmManagerApi } from '@vmm/sdk';
import { ClusterStore } from './clusters/ClusterStore';
import { ConnectionManager } from './clusters/ConnectionManager';
import { registerCommands } from './commands';
import { FakeProvider } from './fake/FakeProvider';
import { ProviderRegistry } from './registry/ProviderRegistry';
import { VmStatusBar } from './status/StatusBar';
import { VmTreeProvider } from './tree/VmTreeProvider';
import { initLog, log } from './util/log';
import { ConsoleManager } from './webview/ConsoleManager';
import { OverviewPanel } from './webview/OverviewPanel';

export function activate(context: vscode.ExtensionContext): VmManagerApi {
	initLog(context);

	const registry = new ProviderRegistry();
	const store = new ClusterStore(context);
	const manager = new ConnectionManager(context, store, registry);
	const tree = new VmTreeProvider(manager, registry);
	const consoles = new ConsoleManager(context.extensionUri, manager);
	const statusBar = new VmStatusBar(manager);

	context.subscriptions.push(
		registry,
		store,
		manager,
		tree,
		consoles,
		statusBar,
		OverviewPanel.registerSerializer(context.extensionUri, manager),
		...registerCommands({ context, store, registry, manager, tree, consoles })
	);

	const updateProviderContext = () =>
		void vscode.commands.executeCommand('setContext', 'vmm.hasProviders', registry.available().length > 0);
	context.subscriptions.push(registry.onDidChange(updateProviderContext));
	updateProviderContext();

	if (context.extensionMode === vscode.ExtensionMode.Development) {
		context.subscriptions.push(registry.register(new FakeProvider()));
	}

	// The walkthrough is opened by VS Code itself right after install
	// (workbench.welcomePage.walkthroughs.openOnInstall) and never on updates.

	log.info('VM Manager activated');

	return {
		apiVersion: VMM_API_VERSION,
		registerProvider: (provider: HypervisorProvider) => registry.register(provider)
	};
}

export function deactivate(): void {
	// Everything is disposed through context.subscriptions.
}
