import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { BrowserLoginService } from './auth/BrowserLogin';
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
import { RdpCredentialStore } from './rdp/credentials';
import { OverviewPanel } from './webview/OverviewPanel';

export function activate(context: vscode.ExtensionContext): VmManagerApi {
	initLog(context);

	const browserLogin = new BrowserLoginService({
		template: readFileSync(context.asAbsolutePath('media/auth/callback.html'), 'utf8'),
		icon: `data:image/png;base64,${readFileSync(context.asAbsolutePath('media/icon.png')).toString('base64')}`,
		editorUrl: `${vscode.env.uriScheme}://`,
		openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url))
	});
	const registry = new ProviderRegistry();
	const store = new ClusterStore(context);
	const manager = new ConnectionManager(context, store, registry);
	const tree = new VmTreeProvider(manager, registry);
	const credentials = new RdpCredentialStore(context.secrets);
	const consoles = new ConsoleManager(context.extensionUri, manager, credentials);
	const statusBar = new VmStatusBar(manager);

	context.subscriptions.push(
		browserLogin,
		registry,
		store,
		manager,
		tree,
		consoles,
		statusBar,
		OverviewPanel.registerSerializer(context.extensionUri, manager),
		...registerCommands({ context, store, registry, manager, tree, consoles, credentials })
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
		registerProvider: (provider: HypervisorProvider) => registry.register(provider),
		browserLogin: (options) => browserLogin.login(options)
	};
}

export function deactivate(): void {
	// Everything is disposed through context.subscriptions.
}
