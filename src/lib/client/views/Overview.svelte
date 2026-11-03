<script lang="ts">
	import { onMount } from 'svelte';
	import Page from '#lib/client-lib/components/layout/Page.svelte';
	import Section from '#lib/client-lib/components/layout/Section.svelte';
	import Flexbox from '#lib/client-lib/components/layout/Flexbox.svelte';
	import Row from '#lib/client-lib/components/grid/Row.svelte';
	import Col from '#lib/client-lib/components/grid/Col.svelte';
	import Card from '#lib/client-lib/components/display/Card.svelte';
	import EmptyMessage from '#lib/client-lib/components/display/EmptyMessage.svelte';
	import Table from '#lib/client-lib/components/table/Table.svelte';
	import Item from '#lib/client-lib/components/table/Item.svelte';
	import Status from '#lib/client-lib/components/feedback/Status.svelte';
	import Loader from '#lib/client-lib/components/feedback/Loader.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import FloatingActionButton from '#lib/client-lib/components/actions/FloatingActionButton.svelte';
	import Dropdown from '#lib/client-lib/components/overlays/Dropdown.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import { formatMemory, formatUptime } from '@vmm/sdk';
	import type { ClusterSnapshot, NodeSnapshot, OverviewCommand, VmSnapshot } from '../../../shared/protocol';
	import { onMessage, request } from '../rpc/bridge';
	import { clusterStates, vmStates } from '../vmState';
	import { clusterContextValue, nodeContextValue, vmContextValue } from '../../../shared/contextValue';
	import { OPERATION_LABEL, allowedDuring } from '../../../shared/operations';

	let clusters = $state<ClusterSnapshot[]>([]);
	let loading = $state(true);
	let failure = $state<string | undefined>();

	const totals = $derived.by(() => {
		const nodes = clusters.flatMap((c) => c.nodes);
		const vms = nodes.flatMap((n) => n.vms);
		const running = vms.filter((v) => v.state === 'running');
		return {
			clusters: clusters.length,
			nodes: nodes.length,
			vms: vms.length,
			running: running.length,
			vcpus: running.reduce((sum, v) => sum + (v.cpus ?? 0), 0),
			memoryMB: running.reduce((sum, v) => sum + (v.memoryMB ?? 0), 0)
		};
	});

	onMount(() => {
		const unsubscribe = onMessage((message) => {
			if (message.kind === 'event' && message.name === 'snapshot') clusters = message.payload;
		});
		request('snapshot')
			.then((result) => (clusters = result))
			.catch((error: Error) => (failure = error.message))
			.finally(() => (loading = false));
		return unsubscribe;
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

	/** client-lib table rows don't forward attributes, so copy the row's context onto the `<tr>` on demand. */
	function promoteRowContext(event: MouseEvent) {
		const row = (event.target as Element | null)?.closest('tr');
		const context = row?.querySelector('[data-row-context]')?.getAttribute('data-row-context');
		if (row && context) row.setAttribute('data-vscode-context', context);
	}

	function nodeSummary(node: NodeSnapshot): string {
		const running = node.vms.filter((v) => v.state === 'running').length;
		const parts = [`${running}/${node.vms.length} running`];
		if (node.cpus) parts.push(`${node.cpus} CPUs`);
		if (node.memoryMB) parts.push(`${formatMemory(node.memoryUsedMB ?? 0)} of ${formatMemory(node.memoryMB)} used`);
		return parts.join(' · ');
	}

	function consolesOf(cluster: ClusterSnapshot, vm: VmSnapshot) {
		const caps = cluster.capabilities;
		const kinds = vm.consoles ?? caps?.consoles ?? [];
		return {
			graphical: kinds.includes('vnc') || !!caps?.preview || !!caps?.external,
			serial: kinds.includes('serial'),
			external: !!caps?.external
		};
	}
</script>

<Page
	title="Virtual Machines"
	description="{totals.clusters} clusters · {totals.nodes} nodes · {totals.running} of {totals.vms} virtual machines running"
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
		<Section>
			<Row>
				<Col xs={6} md={3}>
					<Card title={String(totals.running)} description="Running virtual machines" />
				</Col>
				<Col xs={6} md={3}>
					<Card title={String(totals.vms)} description="Virtual machines" />
				</Col>
				<Col xs={6} md={3}>
					<Card title={String(totals.vcpus)} description="vCPUs in use" />
				</Col>
				<Col xs={6} md={3}>
					<Card title={formatMemory(totals.memoryMB)} description="Memory assigned" />
				</Col>
			</Row>
		</Section>

		{#each clusters as cluster (cluster.id)}
			<div class="context" data-vscode-context={vscodeContext(clusterContextValue(cluster.status), { clusterId: cluster.id })}>
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
					<Row>
						{#each cluster.nodes as node (node.id)}
							<Col xs={12}>
								<div
									class="context"
									data-vscode-context={vscodeContext(nodeContextValue(node.status, cluster.capabilities), { clusterId: cluster.id, nodeId: node.id })}
								>
								<Card title={node.name} description={nodeSummary(node)}>
									{#snippet header()}
										{#if cluster.capabilities?.create && node.status === 'online'}
											<Button
												size="sm"
												transparent
												onclick={() => run('vmm.createVm', { clusterId: cluster.id, nodeId: node.id })}
											>
												<Icon icon="plus-lg" margin="right" />Create VM
											</Button>
										{/if}
									{/snippet}

									{#if node.vms.length === 0}
										<EmptyMessage
											title="No virtual machines"
											description={node.status === 'online'
												? 'Create a virtual machine on this node to see it here.'
												: (node.description ?? 'This node is not reachable.')}
										/>
									{:else}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div class="context" oncontextmenu={promoteRowContext}>
										<Table columns={['State', 'Name', 'vCPU', 'Memory', 'Uptime', 'IP address', '']}>
											{#each node.vms as vm (vm.id)}
												{@const consoles = consolesOf(cluster, vm)}
												{@const caps = cluster.capabilities}
												<Item type="row">
													<Item>
														<span
															data-row-context={vscodeContext(vmContextValue(vm, caps), { clusterId: cluster.id, nodeId: node.id, vmId: vm.id })}
														>
															<Status value={vm.state} states={vmStates} />
															{#if vm.operation}<span class="operation">{OPERATION_LABEL[vm.operation]}</span>{/if}
														</span>
													</Item>
													<Item><strong>{vm.name}</strong></Item>
													<Item>{vm.cpus ?? '–'}</Item>
													<Item>{formatMemory(vm.memoryMB)}</Item>
													<Item>{vm.state === 'running' ? formatUptime(vm.uptimeSeconds) : '–'}</Item>
													<Item><span class="mono">{vm.ipAddresses?.join(', ') || '–'}</span></Item>
													<Item>
														<Flexbox justify="flex-end" align="center" gap="0.25rem">
															{#if vm.state === 'running' && consoles.graphical}
																<Button
																	size="sm"
																	transparent
																	title="Connect"
																	aria-label="Connect graphical console"
																	onclick={() => run('vmm.connectGraphical', { clusterId: cluster.id, nodeId: node.id, vm })}
																>
																	<Icon icon="display" />
																</Button>
															{:else if !vm.operation && vm.state !== 'running' && caps?.power.includes('start')}
																<Button
																	size="sm"
																	transparent
																	title="Start"
																	aria-label="Start"
																	onclick={() => run('vmm.start', { clusterId: cluster.id, nodeId: node.id, vm })}
																>
																	<Icon icon="play-fill" />
																</Button>
															{/if}
															<Dropdown size="sm" transparent alignHorizontal="right" aria-label="Actions for {vm.name}">
																{#snippet menu()}
																	{@const target = { clusterId: cluster.id, nodeId: node.id, vm }}
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
													</Item>
												</Item>
											{/each}
										</Table>
										</div>
									{/if}
								</Card>
								</div>
							</Col>
						{/each}
					</Row>
				{/if}
			</Section>
			</div>
		{/each}
	{/if}

	<FloatingActionButton icon="plus-lg" label="Add cluster" onclick={() => run('vmm.addCluster')} />
</Page>
