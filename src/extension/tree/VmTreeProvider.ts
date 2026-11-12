import * as vscode from 'vscode';
import { formatMemory, formatUptime, type VmState } from '@vmm/sdk';
import type { ClusterStatus, NodeSnapshot } from '../../shared/protocol';
import { clusterContextValue, nodeContextValue, vmContextValue } from '../../shared/contextValue';
import { OPERATION_LABEL } from '../../shared/operations';
import type { ConnectionManager, ClusterRuntime } from '../clusters/ConnectionManager';
import type { ProviderRegistry } from '../registry/ProviderRegistry';
import { originLabel } from '../../shared/origin';
import { operationText } from '../../shared/countdown';
import { groupVms, type GroupBy } from '../../shared/treeGroups';
import type { VmMarksStore } from './VmMarksStore';

/**
 * `parent` on a VM: the group it is listed under when that is not its node (favorites, a tag, a state), which
 * also keeps its tree id unique when it is listed twice.
 */
export type TreeNode =
	| { kind: 'cluster'; clusterId: string }
	| { kind: 'node'; clusterId: string; nodeId: string }
	| { kind: 'vm'; clusterId: string; nodeId: string; vmId: string; parent?: string }
	| { kind: 'group'; id: string; label: string }
	| { kind: 'message'; clusterId: string; id: string };

const FAVORITES = 'favorites';

export function groupBySetting(): GroupBy {
	const value = vscode.workspace.getConfiguration('vmm').get<string>('tree.groupBy', 'cluster');
	return value === 'tag' || value === 'state' ? value : 'cluster';
}

/** The state a grouping files a machine under: a running operation counts as where it is heading. */
function shownState(vm: { state: VmState; operation?: string }): VmState {
	return vm.operation ? (vm.operation === 'start' ? 'starting' : 'stopping') : vm.state;
}

const VM_ICONS: Record<VmState, [string, string?]> = {
	running: ['vm-running', 'testing.iconPassed'],
	stopped: ['vm-outline'],
	paused: ['debug-pause', 'editorWarning.foreground'],
	saved: ['save', 'descriptionForeground'],
	starting: ['loading~spin'],
	stopping: ['loading~spin'],
	unknown: ['question', 'descriptionForeground']
};

/**
 * A template looks like neither a running nor a stopped machine, and a container differs from a VM in
 * shape; the state still shows through the colour (a running container is green, a stopped one plain).
 */
function vmIcon(vm: { state: VmState; template?: boolean; guestKind?: 'vm' | 'container' }): [string, string?] {
	if (vm.template) return ['layers', 'descriptionForeground'];
	const [icon, color] = VM_ICONS[vm.state];
	return vm.guestKind === 'container' && (vm.state === 'running' || vm.state === 'stopped') ? ['package', color] : [icon, color];
}

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
	private readonly groupNodes = new Map<string, TreeNode & { kind: 'group' }>();

	constructor(
		private readonly manager: ConnectionManager,
		private readonly registry: ProviderRegistry,
		private readonly marks: VmMarksStore
	) {
		this.view = vscode.window.createTreeView('vmm.clusters', {
			treeDataProvider: this,
			showCollapseAll: true
		});
		this.disposables.push(
			this.view,
			this.view.onDidChangeVisibility((e) => manager.setVisible('tree', e.visible)),
			manager.onDidChange((clusterId) => {
				this.emitter.fire(clusterId && this.narrow() ? this.clusterNodes.get(clusterId) : undefined);
				this.updateBadge();
			}),
			// The countdown of a running shutdown.
			manager.onDidTick((clusters) => this.emitter.fire(clusters.length === 1 && this.narrow() ? this.clusterNodes.get(clusters[0]) : undefined)),
			registry.onDidChange(() => this.emitter.fire(undefined)),
			marks.onDidChange(() => this.emitter.fire(undefined)),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('vmm.tree.groupBy')) {
					void vscode.commands.executeCommand('setContext', 'vmm.groupBy', groupBySetting());
					this.emitter.fire(undefined);
				}
			})
		);
		void vscode.commands.executeCommand('setContext', 'vmm.groupBy', groupBySetting());
		manager.setVisible('tree', this.view.visible);
	}

	/** A cluster's change only touches that cluster's rows: the tree is by cluster and lists no favorites. */
	private narrow(): boolean {
		return groupBySetting() === 'cluster' && !this.marks.hasFavorites();
	}

	private updateBadge(): void {
		const running = this.manager.runningCount();
		this.view.badge = running ? { value: running, tooltip: `${running} running virtual machine${running === 1 ? '' : 's'}` } : undefined;
	}

	getParent(element: TreeNode): TreeNode | undefined {
		switch (element.kind) {
			case 'cluster':
				return undefined;
			case 'group':
				return undefined;
			case 'node':
			case 'message':
				return this.clusterNodes.get(element.clusterId);
			case 'vm':
				return element.parent ? this.groupNodes.get(element.parent) : { kind: 'node', clusterId: element.clusterId, nodeId: element.nodeId };
		}
	}

	private clusterNode(clusterId: string): TreeNode {
		let node = this.clusterNodes.get(clusterId);
		if (!node) {
			node = { kind: 'cluster', clusterId };
			this.clusterNodes.set(clusterId, node);
		}
		return node;
	}

	/** One object per group id, so expansion and `reveal` keep working across refreshes. */
	private groupNode(id: string, label: string): TreeNode & { kind: 'group' } {
		const node = this.groupNodes.get(id) ?? { kind: 'group' as const, id, label };
		node.label = label;
		this.groupNodes.set(id, node);
		return node;
	}

	private groups(by: Exclude<GroupBy, 'cluster'>) {
		const all = this.manager.allVms();
		const byKey = new Map(all.map((l) => [`${l.ref.clusterId}/${l.ref.nodeId}/${l.ref.vmId}`, l]));
		const groups = groupVms([...byKey].map(([key, l]) => ({ key, name: l.vm.name, state: shownState(l.vm), tags: this.marks.tags(l.ref) })), by);
		return { groups, byKey };
	}

	/** Machines under a group id: favorites, a tag or a state. */
	private groupMembers(id: string): TreeNode[] {
		if (id === FAVORITES) {
			return this.manager
				.allVms()
				.filter((l) => this.marks.isFavorite(l.ref))
				.sort((a, b) => a.vm.name.localeCompare(b.vm.name))
				.map((l) => ({ kind: 'vm', ...l.ref, parent: id }));
		}
		const by = groupBySetting();
		if (by === 'cluster') return [];
		const { groups, byKey } = this.groups(by);
		return (groups.find((g) => g.id === id)?.keys ?? []).map((key) => ({ kind: 'vm', ...byKey.get(key)!.ref, parent: id }));
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			const by = groupBySetting();
			const clusters = this.manager.clusters();
			// Favorites and groups span clusters: load them all (never prompts; a cluster that needs the user says so).
			if (by !== 'cluster' || this.marks.hasFavorites()) await Promise.all(clusters.map((rt) => this.manager.ensureLoaded(rt.cluster.id)));
			const roots: TreeNode[] = [];
			if (this.groupMembers(FAVORITES).length) roots.push(this.groupNode(FAVORITES, 'Favorites'));
			if (by === 'cluster') return [...roots, ...clusters.map((rt) => this.clusterNode(rt.cluster.id))];
			roots.push(...this.groups(by).groups.map((g) => this.groupNode(g.id, g.label)));
			// Clusters that list nothing (signed out, failing, provider missing) stay visible so they can be fixed.
			roots.push(...clusters.filter((rt) => rt.signedOut || rt.status !== 'connected').map((rt) => this.clusterNode(rt.cluster.id)));
			return roots;
		}
		if (element.kind === 'group') return this.groupMembers(element.id);
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
			case 'group':
				return this.groupItem(element);
			case 'message':
				return this.messageItem(element.clusterId);
		}
	}

	/** `ssh me@lab` for a cluster whose machines run on another computer. */
	private remoteLabel(clusterId: string): string | undefined {
		const rt = this.manager.cluster(clusterId);
		return rt ? this.registry.get(rt.cluster.providerId)?.remoteLabel?.(rt.cluster) : undefined;
	}

	private clusterItem(clusterId: string): vscode.TreeItem {
		const rt = this.manager.cluster(clusterId);
		const item = new vscode.TreeItem(rt?.cluster.name ?? clusterId, vscode.TreeItemCollapsibleState.Expanded);
		item.id = `cluster:${clusterId}`;
		if (!rt) return item;
		const providerName = this.registry.displayName(rt.cluster.providerId);
		const statusText = clusterStatusText(rt.status);
		const remote = this.remoteLabel(clusterId);
		const where = remote ? `${providerName} · ${remote}` : providerName;
		item.description = rt.status === 'connected' ? where : `${where} · ${statusText}`;
		item.iconPath = clusterIcon(rt.status, remote ? REMOTE_ICON : this.registry.get(rt.cluster.providerId)?.icon);
		item.contextValue = clusterContextValue(rt.status, rt.connection?.capabilities);
		const tooltip = new vscode.MarkdownString(`**${escapeMd(rt.cluster.name)}**\n\n${providerName} — ${statusText}${remote ? `\n\n$(remote) Runs on another computer: \`${remote}\`` : ''}`);
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
		const nodeIcon = this.remoteLabel(clusterId) ? REMOTE_ICON : 'server';
		item.iconPath = node.status === 'online' ? new vscode.ThemeIcon(nodeIcon) : new vscode.ThemeIcon(nodeIcon, new vscode.ThemeColor('disabledForeground'));
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

	private groupItem(group: { id: string; label: string }): vscode.TreeItem {
		const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
		item.id = `group:${group.id}`;
		item.description = String(this.groupMembers(group.id).length);
		item.iconPath = new vscode.ThemeIcon(group.id === FAVORITES ? 'star-full' : group.id.startsWith('state:') ? 'pulse' : group.id === 'untagged' ? 'circle-slash' : 'tag');
		item.contextValue = `group;${group.id === FAVORITES ? 'favorites' : group.id.startsWith('tag:') ? 'tag' : 'other'};`;
		return item;
	}

	private vmItem(ref: { clusterId: string; nodeId: string; vmId: string; parent?: string }): vscode.TreeItem {
		const location = this.manager.findVm(ref);
		const item = new vscode.TreeItem(location?.vm.name ?? ref.vmId, vscode.TreeItemCollapsibleState.None);
		item.id = `vm:${ref.parent ? `${ref.parent}:` : ''}${ref.clusterId}:${ref.nodeId}:${ref.vmId}`;
		if (!location) return item;
		const { vm } = location;
		const caps = location.cluster.connection?.capabilities;
		const [icon, color] = vmIcon(vm);
		item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
		const startedAt = vm.operation ? this.manager.operationStartedAt(ref) : undefined;
		const label = vm.operation ? (startedAt ? operationText(vm.operation, startedAt, Date.now(), caps?.shutdownTimeoutSeconds) : OPERATION_LABEL[vm.operation]) : stateLabel(vm.state);
		const parts = [...(vm.displayId ? [`#${vm.displayId}`] : []), label];
		const origin = originLabel(vm);
		if (origin) parts.push(origin);
		// Outside its node the row says where it is.
		if (ref.parent) parts.push(location.cluster.cluster.name);
		item.description = parts.join(' · ');
		const marks = this.marks.get(ref);
		item.contextValue = vmContextValue({ ...vm, favorite: marks.favorite }, caps);
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
				(ref.parent ? `| Where | ${escapeMd(location.cluster.cluster.name)} › ${escapeMd(location.node.name)} |\n` : '') +
				(marks.tags?.length ? `| Tags | ${marks.tags.map(escapeMd).join(', ')} |\n` : '') +
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
			const item = new vscode.TreeItem(rt.cancelled ? 'Sign-in cancelled — click to try again' : rt.signInRequired ? 'Sign in required — click to sign in' : 'Signed out — click to sign in');
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

	/** Reveals a machine where the current grouping lists it: its node, else its first group. */
	async revealVm(ref: { clusterId: string; nodeId: string; vmId: string }): Promise<void> {
		const by = groupBySetting();
		if (by === 'cluster') return this.reveal({ kind: 'vm', ...ref });
		const { groups, byKey } = this.groups(by);
		const key = `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;
		const group = groups.find((g) => g.keys.includes(key));
		if (!group || !byKey.has(key)) return;
		this.groupNode(group.id, group.label);
		await this.reveal({ kind: 'vm', ...ref, parent: group.id });
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

/** The codicon for a cluster whose machines run on another computer. */
const REMOTE_ICON = 'remote';

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
