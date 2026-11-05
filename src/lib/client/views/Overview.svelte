<script lang="ts">
	import { onMount } from 'svelte';
	import Page from '#lib/client-lib/components/layout/Page.svelte';
	import Section from '#lib/client-lib/components/layout/Section.svelte';
	import Flexbox from '#lib/client-lib/components/layout/Flexbox.svelte';
	import Card from '#lib/client-lib/components/display/Card.svelte';
	import EmptyMessage from '#lib/client-lib/components/display/EmptyMessage.svelte';
	import Status from '#lib/client-lib/components/feedback/Status.svelte';
	import Loader from '#lib/client-lib/components/feedback/Loader.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import FloatingActionButton from '#lib/client-lib/components/actions/FloatingActionButton.svelte';
	import Dropdown from '#lib/client-lib/components/overlays/Dropdown.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import { toasts } from '#lib/client-lib/components/toast/index.js';
	import { formatMemory, formatUptime, type PowerAction, type VmState } from '@vmm/sdk';
	import type { ClusterSnapshot, NodeSnapshot, OverviewCommand, VmSnapshot } from '../../../shared/protocol';
	import { onMessage, request } from '../rpc/bridge';
	import { clusterStates, vmStates } from '../vmState';
	import { clusterContextValue, nodeContextValue, vmContextValue } from '../../../shared/contextValue';
	import { OPERATION_LABEL, allowedDuring } from '../../../shared/operations';
	import { formatPercent } from '../../../shared/metrics';
	import { originLabel } from '../../../shared/origin';
	import {
		eligibleFor,
		filterRows,
		flattenVms,
		nodeAllocation,
		sortRows,
		stateCounts,
		totalAllocation,
		type SortDirection,
		type SortKey,
		type VmRow
	} from '../../../shared/overview';
	import Meter from '../components/Meter.svelte';
	import Sparkline from '../components/Sparkline.svelte';
	import { seriesColor } from '../chartPalette';
	import { currentThemeKind, onThemeChange } from '../theme-sync';

	const STATS_INTERVAL_MS = 3000;
	const HISTORY_LENGTH = 30;
	const STATE_ORDER: VmState[] = ['running', 'starting', 'stopping', 'paused', 'saved', 'stopped', 'unknown'];

	let clusters = $state<ClusterSnapshot[]>([]);
	let loading = $state(true);
	let failure = $state<string | undefined>();

	let filterText = $state('');
	let stateFilter = $state.raw<Set<VmState>>(new Set());
	let sortKey = $state<SortKey>('state');
	let sortDirection = $state<SortDirection>('asc');
	let selection = $state.raw<Set<string>>(new Set());
	let cpuHistory = $state.raw<Map<string, number[]>>(new Map());
	let kind = $state(currentThemeKind());
	let selectAll: HTMLInputElement | undefined = $state();

	const cpuColor = $derived(seriesColor('cpu', kind));
	const memoryColor = $derived(seriesColor('memory', kind));

	const rows = $derived(flattenVms(clusters));
	const counts = $derived(stateCounts(rows));
	const total = $derived(totalAllocation(clusters));
	const latestCpu = $derived(new Map([...cpuHistory].map(([key, values]) => [key, values[values.length - 1]!] as const)));
	const visible = $derived(sortRows(filterRows(rows, { text: filterText, states: stateFilter }), sortKey, sortDirection, latestCpu));
	const selectedRows = $derived(rows.filter((r) => selection.has(r.key)));
	const allVisibleSelected = $derived(visible.length > 0 && visible.every((r) => selection.has(r.key)));
	const someVisibleSelected = $derived(visible.some((r) => selection.has(r.key)));
	const nodeCount = $derived(clusters.reduce((n, c) => n + c.nodes.length, 0));

	function bulkTargets(action: PowerAction): VmRow[] {
		return selectedRows.filter((r) => eligibleFor(action, r.vm, r.cluster.capabilities?.power));
	}

	$effect(() => {
		if (selectAll) selectAll.indeterminate = someVisibleSelected && !allVisibleSelected;
	});

	// Drop selections of VMs that no longer exist (deleted, cluster removed).
	$effect(() => {
		const keys = new Set(rows.map((r) => r.key));
		if ([...selection].some((k) => !keys.has(k))) selection = new Set([...selection].filter((k) => keys.has(k)));
	});

	function toggleSort(key: SortKey) {
		if (sortKey === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		else {
			sortKey = key;
			sortDirection = key === 'name' || key === 'location' || key === 'state' ? 'asc' : 'desc';
		}
	}

	function toggleState(state: VmState) {
		const next = new Set(stateFilter);
		if (!next.delete(state)) next.add(state);
		stateFilter = next;
	}

	function toggleRow(key: string) {
		const next = new Set(selection);
		if (!next.delete(key)) next.add(key);
		selection = next;
	}

	function toggleAll() {
		const next = new Set(selection);
		if (allVisibleSelected) for (const r of visible) next.delete(r.key);
		else for (const r of visible) next.add(r.key);
		selection = next;
	}

	async function bulk(action: PowerAction) {
		const targets = bulkTargets(action);
		if (!targets.length) return;
		try {
			const result = await request('bulkPower', { action, refs: targets.map((r) => r.ref) });
			if (result.started) {
				const verb = { start: 'Starting', shutdown: 'Shutting down', reboot: 'Rebooting', stop: 'Powering off', reset: 'Resetting' }[action];
				toasts.push({ message: `${verb} ${result.started} virtual machine${result.started === 1 ? '' : 's'}`, icon: 'check-circle-fill', variant: 'success' });
				selection = new Set();
			}
		} catch (error) {
			toasts.push({ message: (error as Error).message, icon: 'exclamation-triangle-fill', variant: 'danger' });
		}
	}

	onMount(() => {
		let alive = true;
		const unsubscribe = onMessage((message) => {
			if (message.kind === 'event' && message.name === 'snapshot') clusters = message.payload;
		});
		const stopTheme = onThemeChange((next) => (kind = next));
		request('snapshot')
			.then((result) => (clusters = result))
			.catch((error: Error) => (failure = error.message))
			.finally(() => (loading = false));

		// CPU sparklines: one batched call per round, sequential so a slow provider just slows the loop.
		void (async () => {
			while (alive) {
				const running = rows.filter((r) => r.vm.state === 'running' && r.cluster.capabilities?.stats);
				if (running.length) {
					try {
						const samples = await request('vmStats', { refs: running.map((r) => r.ref) });
						const next = new Map<string, number[]>();
						const live = new Set(running.map((r) => r.key));
						for (const [key, values] of cpuHistory) if (live.has(key)) next.set(key, values);
						for (const { ref, stats } of samples) {
							const key = `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;
							if (stats.cpuUsage === undefined) continue;
							next.set(key, [...(next.get(key) ?? []), stats.cpuUsage].slice(-HISTORY_LENGTH));
						}
						cpuHistory = next;
					} catch {
						// keep the old history; the next round retries
					}
				} else if (cpuHistory.size) {
					cpuHistory = new Map();
				}
				await new Promise((resolve) => setTimeout(resolve, STATS_INTERVAL_MS));
			}
		})();
		return () => {
			alive = false;
			unsubscribe();
			stopTheme();
		};
	});

	function run(command: OverviewCommand, target: { clusterId?: string; nodeId?: string; vm?: VmSnapshot } = {}) {
		const ref =
			target.vm && target.clusterId && target.nodeId
				? { clusterId: target.clusterId, nodeId: target.nodeId, vmId: target.vm.id }
				: undefined;
		void request('runCommand', { command, ref, clusterId: target.clusterId, nodeId: target.nodeId });
	}

	/**
	 * Native context menus: VS Code reads `data-vscode-context` from the right-clicked element and its
	 * ancestors and shows the `webview/context` menu items whose `when` matches (see package.json).
	 * `vmmItem` carries the same encoding as the tree's contextValue, so both menus stay identical.
	 */
	function vscodeContext(vmmItem: string, ref: { clusterId: string; nodeId?: string; vmId?: string }): string {
		return JSON.stringify({ vmmItem, ...ref, preventDefaultContextMenuItems: true });
	}

	function consolesOf(cluster: ClusterSnapshot, vm: VmSnapshot) {
		const caps = cluster.capabilities;
		const kinds = vm.consoles ?? caps?.consoles ?? [];
		return {
			graphical: kinds.includes('vnc') || !!caps?.preview || !!caps?.external,
			serial: kinds.includes('serial'),
			// Only a terminal (an LXC container): the quick action opens it. A display always wins.
			terminalOnly: kinds.includes('serial') && !kinds.includes('vnc') && !kinds.includes('rdp') && !caps?.preview,
			external: !!caps?.external
		};
	}

	const fraction = (used: number | undefined, of: number | undefined) => (used !== undefined && of ? used / of : undefined);
	const sortMark = (key: SortKey) => (sortKey === key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
	const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' => sortMark(key);
</script>

{#snippet sortHeader(key: SortKey, label: string)}
	<th aria-sort={ariaSort(key)}>
		<button type="button" class="sort" onclick={() => toggleSort(key)}>
			{label}
			{#if sortKey === key}<Icon icon={sortDirection === 'asc' ? 'caret-up-fill' : 'caret-down-fill'} />{/if}
		</button>
	</th>
{/snippet}

<Page
	title="Virtual Machines"
	description="{clusters.length} clusters · {nodeCount} nodes · {counts.running} of {rows.length} virtual machines running"
	sticky_header={false}
>
	{#snippet suffix()}
		<Button transparent title="Refresh" aria-label="Refresh" onclick={() => run('vmm.refresh')}>
			<Icon icon="arrow-clockwise" />
		</Button>
	{/snippet}

	{#if loading}
		<Flexbox justify="center" style="padding: 3rem 0;"><Loader /></Flexbox>
	{:else if failure}
		<Section>
			<Card variant="danger" title="Could not load clusters" description={failure} />
		</Section>
	{:else if clusters.length === 0}
		<Section>
			<Card>
				<EmptyMessage
					title="No clusters yet"
					description="A cluster is one hypervisor installation, such as your local Hyper-V or a Proxmox cluster. Add one to get started."
				/>
			</Card>
		</Section>
	{:else}
		<!-- Summary: how many VMs are in which state, and what they take from the hosts. -->
		<Section>
			<div class="summary">
				<Card title="{counts.running} of {rows.length} running" description="Virtual machines by state">
					{#if rows.length}
						<div class="stack" role="img" aria-label={STATE_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${vmStates[s].title}`).join(', ')}>
							{#each STATE_ORDER.filter((s) => counts[s]) as state (state)}
								<span class="segment" style="flex: {counts[state]}; background: {vmStates[state].color}" title="{counts[state]} {vmStates[state].title}"></span>
							{/each}
						</div>
						<ul class="chips">
							{#each STATE_ORDER.filter((s) => counts[s] || stateFilter.has(s)) as state (state)}
								<li>
									<button type="button" class="chip" aria-pressed={stateFilter.has(state)} onclick={() => toggleState(state)} title="Show only {vmStates[state].title?.toLowerCase()}">
										<span class="dot" style="background: {vmStates[state].color}"></span>
										{vmStates[state].title}
										<strong>{counts[state]}</strong>
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="muted">No virtual machines yet.</p>
					{/if}
				</Card>
				<Card title="Allocated to running VMs" description="Against the capacity of all online nodes">
					<div class="meters">
						<Meter
							label="vCPUs"
							value="{total.vcpus} of {total.hostCpus ?? '?'}"
							fraction={fraction(total.vcpus, total.hostCpus)}
							color={cpuColor}
							over={!!total.hostCpus && total.vcpus > total.hostCpus}
						/>
						<Meter
							label="Memory"
							value="{formatMemory(total.memoryMB)} of {formatMemory(total.hostMemoryMB)}"
							fraction={fraction(total.memoryMB, total.hostMemoryMB)}
							color={memoryColor}
							over={!!total.hostMemoryMB && total.memoryMB > total.hostMemoryMB}
						/>
					</div>
				</Card>
			</div>
		</Section>

		<!-- Hosts: one card per node with its live load and allocation. -->
		{#each clusters as cluster (cluster.id)}
			<div class="context" data-vscode-context={vscodeContext(clusterContextValue(cluster.status, cluster.capabilities), { clusterId: cluster.id })}>
				<Section title={cluster.name} description={cluster.providerName}>
					{#snippet headerSuffix()}
						<Flexbox align="center" gap="0.5rem">
							<Status value={cluster.status} states={clusterStates} />
							<Dropdown transparent alignHorizontal="right" aria-label="Cluster actions">
								{#snippet menu()}
									<Button transparent onclick={() => run('vmm.refresh', { clusterId: cluster.id })}>
										<Icon icon="arrow-clockwise" margin="right" />Refresh
									</Button>
									<Button transparent onclick={() => run('vmm.reconnectCluster', { clusterId: cluster.id })}>
										<Icon icon="plug" margin="right" />Reconnect
									</Button>
									<Button transparent onclick={() => run('vmm.editCluster', { clusterId: cluster.id })}>
										<Icon icon="pencil" margin="right" />Edit cluster
									</Button>
								{/snippet}
							</Dropdown>
						</Flexbox>
					{/snippet}

					{#if cluster.status === 'error' || cluster.status === 'missingProvider'}
						<Card
							variant={cluster.status === 'error' ? 'danger' : 'warning'}
							title={cluster.status === 'error' ? 'Connection failed' : 'Provider not installed'}
							description={cluster.error}
						>
							<Button onclick={() => run('vmm.reconnectCluster', { clusterId: cluster.id })}>
								<Icon icon="plug" margin="right" />Reconnect
							</Button>
						</Card>
					{:else if cluster.nodes.length === 0}
						<Card>
							<Flexbox justify="center" style="padding: 1rem 0;"><Loader /></Flexbox>
						</Card>
					{:else}
						<div class="nodes">
							{#each cluster.nodes as node (node.id)}
								{@const alloc = nodeAllocation(node)}
								<div class="context" data-vscode-context={vscodeContext(nodeContextValue(node.status, cluster.capabilities), { clusterId: cluster.id, nodeId: node.id })}>
									<Card title={node.name} description="{alloc.running} of {alloc.total} running{node.cpus ? ` · ${node.cpus} CPUs` : ''}{node.memoryMB ? ` · ${formatMemory(node.memoryMB)}` : ''}">
										{#snippet header()}
											{#if cluster.capabilities?.adopt && node.status === 'online'}
												<Button size="sm" transparent title="Attach to a QEMU VM that is already running" onclick={() => run('vmm.attachRunningVm', { clusterId: cluster.id, nodeId: node.id })}>
													<Icon icon="plug" margin="right" />Attach
												</Button>
											{/if}
											{#if cluster.capabilities?.importFolder && node.status === 'online'}
												<Button size="sm" transparent title="Import disk images or VM definitions from a folder" onclick={() => run('vmm.importFromFolder', { clusterId: cluster.id, nodeId: node.id })}>
													<Icon icon="folder2-open" margin="right" />Import
												</Button>
											{/if}
											{#if cluster.capabilities?.create && node.status === 'online'}
												<Button size="sm" transparent onclick={() => run('vmm.createVm', { clusterId: cluster.id, nodeId: node.id })}>
													<Icon icon="plus-lg" margin="right" />Create VM
												</Button>
											{/if}
										{/snippet}
										{#if node.status !== 'online'}
											<p class="muted">{node.description ?? 'This node is not reachable.'}</p>
										{:else}
											<div class="meters">
												{#if node.cpuUsage !== undefined}
													<Meter label="CPU load" value={formatPercent(node.cpuUsage)} fraction={node.cpuUsage} color={cpuColor} />
												{/if}
												{#if node.memoryMB}
													<Meter
														label="Memory in use"
														value="{formatMemory(node.memoryUsedMB ?? 0)} of {formatMemory(node.memoryMB)}"
														fraction={fraction(node.memoryUsedMB, node.memoryMB)}
														color={memoryColor}
													/>
												{/if}
												{#if node.cpus}
													<Meter label="vCPUs allocated" value="{alloc.vcpus} of {node.cpus}" fraction={fraction(alloc.vcpus, node.cpus)} color={cpuColor} over={alloc.vcpus > node.cpus} />
												{/if}
												{#if node.memoryMB}
													<Meter
														label="Memory allocated"
														value="{formatMemory(alloc.memoryMB)} of {formatMemory(node.memoryMB)}"
														fraction={fraction(alloc.memoryMB, node.memoryMB)}
														color={memoryColor}
														over={alloc.memoryMB > node.memoryMB}
													/>
												{/if}
											</div>
											{#if node.facts?.length}
												<dl class="facts">
													{#each node.facts as fact (fact.label)}
														<div><dt>{fact.label}</dt><dd title={fact.value}>{fact.value}</dd></div>
													{/each}
												</dl>
											{/if}
										{/if}
									</Card>
								</div>
							{/each}
						</div>
					{/if}
				</Section>
			</div>
		{/each}

		<!-- All virtual machines of all clusters, filterable and sortable, with bulk power actions. -->
		<Section title="All virtual machines" description="{visible.length}{visible.length === rows.length ? '' : ` of ${rows.length}`} shown">
			<Card>
				<div class="toolbar">
					<input
						type="search"
						class="search"
						placeholder="Filter by name, host or IP address"
						aria-label="Filter virtual machines"
						bind:value={filterText}
					/>
					<div class="bulk" aria-live="polite">
						{#if selectedRows.length}
							<span class="muted">{selectedRows.length} selected</span>
							<Button size="sm" disabled={!bulkTargets('start').length} onclick={() => bulk('start')}>
								<Icon icon="play-fill" margin="right" />Start ({bulkTargets('start').length})
							</Button>
							<Button size="sm" disabled={!bulkTargets('shutdown').length} onclick={() => bulk('shutdown')}>
								<Icon icon="power" margin="right" />Shut down ({bulkTargets('shutdown').length})
							</Button>
							<Button size="sm" transparent disabled={!bulkTargets('stop').length} onclick={() => bulk('stop')}>
								<Icon icon="stop-fill" margin="right" />Power off ({bulkTargets('stop').length})
							</Button>
							<Button size="sm" transparent onclick={() => (selection = new Set())}>Clear</Button>
						{/if}
					</div>
				</div>

				{#if rows.length === 0}
					<EmptyMessage title="No virtual machines" description="Create a virtual machine on one of the nodes above to see it here." />
				{:else if visible.length === 0}
					<EmptyMessage title="Nothing matches" description="Change the filter or clear the state filter above." />
				{:else}
					<div class="scroll">
						<table class="vms">
							<thead>
								<tr>
									<th class="check">
										<input type="checkbox" bind:this={selectAll} checked={allVisibleSelected} onchange={toggleAll} aria-label="Select all shown virtual machines" />
									</th>
									{@render sortHeader('state', 'State')}
									{@render sortHeader('name', 'Name')}
									{@render sortHeader('location', 'Host')}
									{@render sortHeader('cpus', 'vCPU')}
									{@render sortHeader('memory', 'Memory')}
									{@render sortHeader('cpu', 'CPU')}
									{@render sortHeader('uptime', 'Uptime')}
									<th>IP address</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								{#each visible as row (row.key)}
									{@const vm = row.vm}
									{@const caps = row.cluster.capabilities}
									{@const consoles = consolesOf(row.cluster, vm)}
									{@const target = { clusterId: row.ref.clusterId, nodeId: row.ref.nodeId, vm }}
									{@const history = cpuHistory.get(row.key) ?? []}
									<tr data-vscode-context={vscodeContext(vmContextValue(vm, caps), row.ref)} class:selected={selection.has(row.key)}>
										<td class="check"><input type="checkbox" checked={selection.has(row.key)} onchange={() => toggleRow(row.key)} aria-label="Select {vm.name}" /></td>
										<td>
											<Status value={vm.state} states={vmStates} />
											{#if vm.operation}<span class="muted">{OPERATION_LABEL[vm.operation]}</span>{/if}
										</td>
										<td>
											{#if caps?.details || caps?.stats}
												<button type="button" class="link" onclick={() => run('vmm.openVmDashboard', target)} title="Show details">{vm.name}</button>
											{:else}
												<strong>{vm.name}</strong>
											{/if}
											{#if originLabel(vm)}<span class="badge" title="Not created by VM Manager">{originLabel(vm)}</span>{/if}
										</td>
										<td class="muted">{row.cluster.name} › {row.node.name}</td>
										<td>{vm.cpus ?? '–'}</td>
										<td>{formatMemory(vm.memoryMB)}</td>
										<td>
											{#if vm.state === 'running' && history.length}
												<span class="cpu"><Sparkline values={history} color={cpuColor} /><span>{formatPercent(history[history.length - 1])}</span></span>
											{:else}
												<span class="muted">–</span>
											{/if}
										</td>
										<td>{vm.state === 'running' ? formatUptime(vm.uptimeSeconds) : '–'}</td>
										<td><span class="mono">{vm.ipAddresses?.join(', ') || '–'}</span></td>
										<td class="actions">
											<Flexbox justify="flex-end" align="center" gap="0.25rem">
												{#if vm.state === 'running' && consoles.terminalOnly}
													<Button size="sm" transparent title="Open terminal" aria-label="Open terminal" onclick={() => run('vmm.connectSerial', target)}>
														<Icon icon="terminal" />
													</Button>
												{:else if vm.state === 'running' && consoles.graphical}
													<Button size="sm" transparent title="Connect" aria-label="Connect graphical console" onclick={() => run('vmm.connectGraphical', target)}>
														<Icon icon="display" />
													</Button>
												{:else if !vm.operation && vm.state !== 'running' && caps?.power.includes('start')}
													<Button size="sm" transparent title="Start" aria-label="Start" onclick={() => run('vmm.start', target)}>
														<Icon icon="play-fill" />
													</Button>
												{/if}
												<Dropdown size="sm" transparent alignHorizontal="right" aria-label="Actions for {vm.name}">
													{#snippet menu()}
														{#if caps?.details || caps?.stats}
															<Button transparent onclick={() => run('vmm.openVmDashboard', target)}><Icon icon="graph-up" margin="right" />Details</Button>
														{/if}
														{#if !vm.operation && vm.state !== 'running' && caps?.power.includes('start')}
															<Button transparent onclick={() => run('vmm.start', target)}><Icon icon="play-fill" margin="right" />Start</Button>
														{/if}
														{#if !vm.operation && vm.state === 'running' && caps?.power.includes('shutdown')}
															<Button transparent onclick={() => run('vmm.shutdown', target)}><Icon icon="power" margin="right" />Shut down</Button>
														{/if}
														{#if !vm.operation && vm.state === 'running' && caps?.power.includes('reboot')}
															<Button transparent onclick={() => run('vmm.reboot', target)}><Icon icon="arrow-repeat" margin="right" />Reboot</Button>
														{/if}
														{#if (vm.operation ? allowedDuring(vm.operation, 'stop') : vm.state !== 'stopped') && caps?.power.includes('stop')}
															<Button transparent onclick={() => run('vmm.stop', target)}><Icon icon="stop-fill" margin="right" />Stop (power off)</Button>
														{/if}
														{#if consoles.graphical}
															<Button transparent onclick={() => run('vmm.connectGraphical', target)}><Icon icon="display" margin="right" />Graphical console</Button>
														{/if}
														{#if consoles.serial}
															<Button transparent onclick={() => run('vmm.connectSerial', target)}><Icon icon="terminal" margin="right" />Serial console</Button>
														{/if}
														{#if consoles.external}
															<Button transparent onclick={() => run('vmm.openExternal', target)}><Icon icon="box-arrow-up-right" margin="right" />Native viewer</Button>
														{/if}
														{#if caps?.edit}
															<Button transparent onclick={() => run('vmm.editVm', target)}><Icon icon="gear" margin="right" />Settings</Button>
														{/if}
														{#if caps?.delete}
															<Button transparent variant="danger" onclick={() => run('vmm.deleteVm', target)}><Icon icon="trash" margin="right" />Delete</Button>
														{/if}
													{/snippet}
												</Dropdown>
											</Flexbox>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</Card>
		</Section>
	{/if}

	<FloatingActionButton icon="plus-lg" label="Add cluster" onclick={() => run('vmm.addCluster')} />
</Page>

<style>
	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 1rem;
	}
	.stack {
		display: flex;
		gap: 2px; /* the surface shows through: segments are separated by a gap, not a border */
		width: 100%;
		height: 12px;
		margin: 0.5rem 0 0.75rem;
	}
	.segment {
		min-width: 6px;
		border-radius: 3px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--vscode-widget-border, #8883);
		background: transparent;
		color: var(--vscode-foreground);
		font: inherit;
		cursor: pointer;
	}
	.chip:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.chip[aria-pressed='true'] {
		border-color: var(--vscode-focusBorder);
		background: var(--vscode-list-hoverBackground);
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex: none;
	}
	.meters {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 0.75rem 1.5rem;
	}
	.nodes {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.facts {
		display: grid;
		gap: 0.2rem;
		margin: 1rem 0 0;
		font-size: 0.9em;
	}
	.facts div {
		display: flex;
		gap: 0.75rem;
		min-width: 0;
	}
	.facts dt {
		color: var(--vscode-descriptionForeground);
		flex: none;
		min-width: 8rem;
	}
	.facts dd {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}
	.search {
		flex: 1 1 260px;
		max-width: 420px;
		padding: 0.35rem 0.6rem;
		border-radius: 4px;
		border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8883));
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground, var(--vscode-foreground));
		font: inherit;
	}
	.search:focus {
		outline: 1px solid var(--vscode-focusBorder);
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		min-height: 2rem;
	}
	.scroll {
		overflow-x: auto;
	}
	.vms {
		width: 100%;
		border-collapse: collapse;
	}
	.vms th {
		text-align: left;
		font-weight: 600;
		color: var(--vscode-descriptionForeground);
		white-space: nowrap;
		padding: 0.3rem 0.75rem 0.3rem 0;
	}
	.vms td {
		padding: 0.4rem 0.75rem 0.4rem 0;
		border-top: 1px solid var(--vscode-widget-border, #8883);
		vertical-align: middle;
		font-variant-numeric: tabular-nums;
	}
	.vms tr.selected td {
		background: color-mix(in srgb, var(--vscode-focusBorder) 8%, transparent);
	}
	.check {
		width: 1.5rem;
	}
	.sort,
	.link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.sort {
		font-weight: 600;
		color: var(--vscode-descriptionForeground);
	}
	.sort:hover,
	.link:hover {
		text-decoration: underline;
	}
	.link {
		font-weight: 600;
		color: var(--vscode-textLink-foreground, inherit);
	}
	.cpu {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
	.cpu span:last-child {
		min-width: 3ch;
		text-align: right;
	}
	.actions {
		text-align: right;
		white-space: nowrap;
	}
	.mono {
		font-family: var(--vscode-editor-font-family, monospace);
	}
	.badge {
		margin-left: 0.4rem;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		font-size: 0.8em;
		color: var(--vscode-badge-foreground, inherit);
		background: var(--vscode-badge-background, #8883);
		white-space: nowrap;
	}
	.muted {
		color: var(--vscode-descriptionForeground);
	}
</style>
