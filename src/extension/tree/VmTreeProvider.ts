import * as vscode from 'vscode';
import { formatMemory, formatUptime, type VmState } from '@vmm/sdk';
import type { ClusterStatus, NodeSnapshot } from '../../shared/protocol';
import { clusterContextValue, nodeContextValue, vmContextValue } from '../../shared/contextValue';
import { OPERATION_LABEL } from '../../shared/operations';
import type { ConnectionManager, ClusterRuntime } from '../clusters/ConnectionManager';
import type { ProviderRegistry } from '../registry/ProviderRegistry';
import { originLabel } from '../../shared/origin';

export type TreeNode =
	| { kind: 'cluster'; clusterId: string }
	| { kind: 'node'; clusterId: string; nodeId: string }
	| { kind: 'vm'; clusterId: string; nodeId: string; vmId: string }
	| { kind: 'message'; clusterId: string; id: string };

const VM_ICONS: Record<VmState, [string, string?]> = {
	running: ['vm-running', 'testing.iconPassed'],
	stopped: ['vm-outline'],
	paused: ['debug-pause', 'editorWarning.foreground'],
	saved: ['save', 'descriptionForeground'],
	starting: ['loading~spin'],
	stopping: ['loading~spin'],
	unknown: ['question', 'descriptionForeground']
};

const STATE_LABEL: Record<VmState, string> = {
	running: 'Running',
	stopped: 'Off',
	paused: 'Paused',
	saved: 'Saved',
	starting: 'Starting…',
	stopping: 'Stopping…',
	unknown: 'Unknown'
};

export function stateLabel(state: VmState): string {
	return STATE_LABEL[state];
}

export class VmTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly view: vscode.TreeView<TreeNode>;
	private readonly disposables: vscode.Disposable[] = [this.emitter];
	/** Stable element identities so VS Code keeps expansion/selection state across refreshes. */
	private readonly clusterNodes = new Map<string, TreeNode>();

	constructor(
		private readonly manager: ConnectionManager,
		private readonly registry: ProviderRegistry
	) {
		this.view = vscode.window.createTreeView('vmm.clusters', {
			treeDataProvider: this,
			showCollapseAll: true
		});
		this.disposables.push(
			this.view,
			this.view.onDidChangeVisibility((e) => manager.setVisible('tree', e.visible)),
			manager.onDidChange((clusterId) => {
				this.emitter.fire(clusterId ? this.clusterNodes.get(clusterId) : undefined);
				this.updateBadge();
			}),
			registry.onDidChange(() => this.emitter.fire(undefined))
		);
		manager.setVisible('tree', this.view.visible);
	}

	private updateBadge(): void {
		const running = this.manager.runningCount();
		this.view.badge = running ? { value: running, tooltip: `${running} running virtual machine${running === 1 ? '' : 's'}` } : undefined;
	}

	getParent(element: TreeNode): TreeNode | undefined {
		switch (element.kind) {
			case 'cluster':
				return undefined;
			case 'node':
			case 'message':
				return this.clusterNodes.get(element.clusterId);
			case 'vm':
				return { kind: 'node', clusterId: element.clusterId, nodeId: element.nodeId };
		}
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			return this.manager.clusters().map((rt) => {
				let node = this.clusterNodes.get(rt.cluster.id);
				if (!node) {
					node = { kind: 'cluster', clusterId: rt.cluster.id };
					this.clusterNodes.set(rt.cluster.id, node);
				}
				return node;
			});
		}
		if (element.kind === 'cluster') {
			await this.manager.ensureLoaded(element.clusterId);
			const rt = this.manager.cluster(element.clusterId);
			if (!rt) return [];
			if (rt.signedOut) return [{ kind: 'message', clusterId: rt.cluster.id, id: 'signedOut' }];
			if (rt.status === 'error' || rt.status === 'missingProvider') {
				return [{ kind: 'message', clusterId: rt.cluster.id, id: rt.status }];
			}
			return rt.nodes.map((n) => ({ kind: 'node', clusterId: rt.cluster.id, nodeId: n.id }));
		}
		if (element.kind === 'node') {
			const node = this.manager.node(element.clusterId, element.nodeId);
			return (node?.vms ?? []).map((vm) => ({
				kind: 'vm',
				clusterId: element.clusterId,
				nodeId: element.nodeId,
				vmId: vm.id
			}));
		}
		return [];
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		switch (element.kind) {
			case 'cluster':
				return this.clusterItem(element.clusterId);
			case 'node':
				return this.nodeItem(element.clusterId, element.nodeId);
			case 'vm':
				return this.vmItem(element);
			case 'message':
				return this.messageItem(element.clusterId);
		}
	}

	private clusterItem(clusterId: string): vscode.TreeItem {
		const rt = this.manager.cluster(clusterId);
		const item = new vscode.TreeItem(rt?.cluster.name ?? clusterId, vscode.TreeItemCollapsibleState.Expanded);
		item.id = `cluster:${clusterId}`;
		if (!rt) return item;
		const providerName = this.registry.displayName(rt.cluster.providerId);
		const statusText = clusterStatusText(rt.status);
		item.description = rt.status === 'connected' ? providerName : `${providerName} · ${statusText}`;
		item.iconPath = clusterIcon(rt.status, this.registry.get(rt.cluster.providerId)?.icon);
		item.contextValue = clusterContextValue(rt.status, rt.connection?.capabilities);
		const tooltip = new vscode.MarkdownString(`**${escapeMd(rt.cluster.name)}**\n\n${providerName} — ${statusText}`);
		if (rt.error) tooltip.appendMarkdown(`\n\n$(error) ${escapeMd(rt.error)}`);
		tooltip.supportThemeIcons = true;
		item.tooltip = tooltip;
		return item;
	}

	private nodeItem(clusterId: string, nodeId: string): vscode.TreeItem {
		const rt = this.manager.cluster(clusterId);
		const node = this.manager.node(clusterId, nodeId);
		const item = new vscode.TreeItem(node?.name ?? nodeId, vscode.TreeItemCollapsibleState.Expanded);
		item.id = `node:${clusterId}:${nodeId}`;
		if (!node) return item;
		item.description = nodeDescription(node);
		item.iconPath =
			node.status === 'online'
				? new vscode.ThemeIcon('server')
				: new vscode.ThemeIcon('server', new vscode.ThemeColor('disabledForeground'));
		const caps = rt?.connection?.capabilities;
		item.contextValue = nodeContextValue(node.status, caps);
		const running = node.vms.filter((v) => v.state === 'running').length;
		item.tooltip = new vscode.MarkdownString(
			`**${escapeMd(node.name)}** — ${node.status}\n\n` +
				`| | |\n|---|---|\n` +
				`| CPUs | ${node.cpus ?? '–'} |\n` +
				`| Memory | ${formatMemory(node.memoryUsedMB)} / ${formatMemory(node.memoryMB)} |\n` +
				`| VMs | ${running} running / ${node.vms.length} total |` +
				(node.description ? `\n\n${escapeMd(node.description)}` : '')
		);
		return item;
	}

	private vmItem(ref: { clusterId: string; nodeId: string; vmId: string }): vscode.TreeItem {
		const location = this.manager.findVm(ref);
		const item = new vscode.TreeItem(location?.vm.name ?? ref.vmId, vscode.TreeItemCollapsibleState.None);
		item.id = `vm:${ref.clusterId}:${ref.nodeId}:${ref.vmId}`;
		if (!location) return item;
		const { vm } = location;
		const caps = location.cluster.connection?.capabilities;
		const [icon, color] = VM_ICONS[vm.state];
		item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
		const label = vm.operation ? OPERATION_LABEL[vm.operation] : stateLabel(vm.state);
		const parts = [...(vm.displayId ? [`#${vm.displayId}`] : []), label];
		const origin = originLabel(vm);
		if (origin) parts.push(origin);
		item.description = parts.join(' · ');
		item.contextValue = vmContextValue(vm, caps);
		// Clicking a VM opens its details (providers without inventory/stats keep a plain, selectable row).
		if (caps?.details || caps?.stats) {
			item.command = {
				command: 'vmm.openVmDashboard',
				title: 'Show Details',
				arguments: [{ clusterId: ref.clusterId, nodeId: ref.nodeId, vmId: ref.vmId }]
			};
		}
		const md = new vscode.MarkdownString(
			`**${escapeMd(vm.name)}** — ${label}\n\n` +
				`| | |\n|---|---|\n` +
				(vm.displayId ? `| ID | ${escapeMd(vm.displayId)} |\n` : '') +
				`| vCPUs | ${vm.cpus ?? '–'} |\n` +
				`| Memory | ${formatMemory(vm.memoryMB)} |\n` +
				`| Uptime | ${formatUptime(vm.uptimeSeconds)} |\n` +
				(vm.ipAddresses?.length ? `| IP | ${vm.ipAddresses.join(', ')} |\n` : '') +
				(vm.os ? `| OS | ${escapeMd(vm.os)} |\n` : '') +
				(vm.origin ? `| Origin | ${vm.origin === 'adopted' ? 'Attached to a process started outside VM Manager' : 'Imported from existing files'}${vm.controllable === false ? ' (observe only: no control socket)' : ''} |\n` : '') +
				(vm.description ? `\n${escapeMd(vm.description)}` : '')
		);
		item.tooltip = md;
		return item;
	}

	private messageItem(clusterId: string): vscode.TreeItem {
		const rt = this.manager.cluster(clusterId);
		if (rt?.status === 'missingProvider') {
			const item = new vscode.TreeItem('Provider not installed — click to install');
			item.iconPath = new vscode.ThemeIcon('extensions');
			item.command = { command: 'vmm.installProviders', title: 'Install Provider', arguments: [rt.cluster.providerId] };
			item.id = `msg:${clusterId}:missing`;
			return item;
		}
		if (rt?.signedOut) {
			const item = new vscode.TreeItem('Signed out — click to sign in');
			item.iconPath = new vscode.ThemeIcon('sign-in');
			item.command = { command: 'vmm.reconnectCluster', title: 'Sign In', arguments: [{ kind: 'cluster', clusterId }] };
			item.id = `msg:${clusterId}:signedOut`;
			return item;
		}
		const item = new vscode.TreeItem(`Connection failed — click to retry`);
		item.description = rt?.error;
		item.tooltip = rt?.error;
		item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
		item.command = { command: 'vmm.reconnectCluster', title: 'Reconnect', arguments: [{ kind: 'cluster', clusterId }] };
		item.id = `msg:${clusterId}:error`;
		return item;
	}

	async reveal(element: TreeNode): Promise<void> {
		await this.view.reveal(element, { select: true, focus: false, expand: true });
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

function clusterStatusText(status: ClusterStatus): string {
	switch (status) {
		case 'connected':
			return 'Connected';
		case 'connecting':
			return 'Connecting…';
		case 'disconnected':
			return 'Not connected';
		case 'error':
			return 'Connection failed';
		case 'missingProvider':
			return 'Provider not installed';
	}
}

function clusterIcon(status: ClusterStatus, providerIcon: string | undefined): vscode.ThemeIcon {
	switch (status) {
		case 'connecting':
			return new vscode.ThemeIcon('loading~spin');
		case 'error':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
		case 'missingProvider':
			return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
		default:
			return new vscode.ThemeIcon(providerIcon ?? 'server-environment');
	}
}

function nodeDescription(node: NodeSnapshot): string {
	if (node.status === 'offline') return 'Offline';
	const parts: string[] = [];
	const running = node.vms.filter((v) => v.state === 'running');
	const vcpus = running.reduce((sum, v) => sum + (v.cpus ?? 0), 0);
	if (node.cpus) parts.push(`${vcpus}/${node.cpus} vCPU`);
	if (node.memoryMB) parts.push(`${formatMemory(node.memoryUsedMB ?? 0)}/${formatMemory(node.memoryMB)}`);
	return parts.join(' · ');
}

function escapeMd(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export type { ClusterRuntime };
