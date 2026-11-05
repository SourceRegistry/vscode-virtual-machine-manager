<script lang="ts">
	import { onMount } from 'svelte';
	import Page from '#lib/client-lib/components/layout/Page.svelte';
	import Section from '#lib/client-lib/components/layout/Section.svelte';
	import Flexbox from '#lib/client-lib/components/layout/Flexbox.svelte';
	import Card from '#lib/client-lib/components/display/Card.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import Loader from '#lib/client-lib/components/feedback/Loader.svelte';
	import Status from '#lib/client-lib/components/feedback/Status.svelte';
	import { formatMemory, formatUptime, type Capabilities, type VmDetails, type VmInfo, type VmStats } from '@vmm/sdk';
	import type { BootData, OverviewCommand } from '../../../shared/protocol';
	import {
		column,
		derivePoint,
		formatBytes,
		formatIops,
		formatLatency,
		formatPercent,
		formatRate,
		trimWindow,
		type MetricPoint
	} from '../../../shared/metrics';
	import { OPERATION_LABEL } from '../../../shared/operations';
	import LineChart from '../components/LineChart.svelte';
	import { onMessage, request } from '../rpc/bridge';
	import { vmStates } from '../vmState';

	let { boot }: { boot: BootData } = $props();

	const STATS_INTERVAL_MS = 2000;
	const DETAILS_INTERVAL_MS = 10_000;

	let vm = $state<(VmInfo & { operation?: string }) | undefined>();
	let caps = $state<Capabilities | undefined>();
	let details = $state<VmDetails | undefined>();
	let detailsError = $state<string | undefined>();
	let loading = $state(true);
	let points = $state.raw<MetricPoint[]>([]);
	let statsError = $state<string | undefined>();
	let showTable = $state(false);
	let previous: VmStats | undefined;

	const running = $derived(vm?.state === 'running');
	const latest = $derived(points[points.length - 1]);
	const ips = $derived(
		[...(vm?.ipAddresses ?? []), ...(details?.nics.flatMap((n) => n.ipAddresses ?? []) ?? [])].filter((ip, i, all) => all.indexOf(ip) === i)
	);

	const cpuData = $derived(column(points, ['cpu']));
	const memoryData = $derived(column(points, ['memoryUsedMB']));
	const throughputData = $derived(column(points, ['readBps', 'writeBps']));
	const iopsData = $derived(column(points, ['readIops', 'writeIops']));
	const latencyData = $derived(column(points, ['readLatencyMs', 'writeLatencyMs']));
	const hasDiskStats = $derived(points.some((p) => p.readBps !== null));
	const memoryTop = $derived(Math.max(vm?.memoryMB ?? 0, ...points.map((p) => p.memoryMB ?? 0), 1));

	function run(command: OverviewCommand) {
		if (!boot.ref) return;
		void request('runCommand', { command, ref: boot.ref });
	}

	async function loadDetails() {
		try {
			details = await request('getDetails');
			detailsError = undefined;
		} catch (error) {
			detailsError = (error as Error).message;
		}
	}

	async function sampleOnce() {
		try {
			const stats = await request('getStats');
			statsError = undefined;
			if (!stats) return;
			points = trimWindow([...points, derivePoint(previous, stats)]);
			previous = stats;
		} catch (error) {
			statsError = (error as Error).message;
		}
	}

	// A VM that stops (or restarts) starts a fresh history: its counters begin again at zero.
	let wasRunning = false;
	$effect(() => {
		if (running !== wasRunning) {
			wasRunning = running;
			points = [];
			previous = undefined;
			void loadDetails();
		}
	});

	// Media changes and renames arrive as VM events: refresh the inventory.
	let lastMedia: boolean | undefined;
	$effect(() => {
		const media = vm?.mediaInserted;
		if (lastMedia !== undefined && media !== lastMedia) void loadDetails();
		lastMedia = media;
	});

	onMount(() => {
		let alive = true;
		const unsubscribe = onMessage((message) => {
			if (message.kind === 'event' && message.name === 'vm') vm = message.payload;
		});
		void (async () => {
			try {
				const dashboard = await request('getDashboard');
				vm = dashboard.vm;
				caps = dashboard.capabilities;
			} finally {
				loading = false;
			}
			await loadDetails();
		})();
		// Sequential loops: a slow provider (for example Windows process sampling) slows the loop
		// down instead of piling up requests.
		void (async () => {
			while (alive) {
				if (running && caps?.stats) await sampleOnce();
				await new Promise((resolve) => setTimeout(resolve, STATS_INTERVAL_MS));
			}
		})();
		const detailsTimer = setInterval(() => void loadDetails(), DETAILS_INTERVAL_MS);
		return () => {
			alive = false;
			clearInterval(detailsTimer);
			unsubscribe();
		};
	});

	const rows = $derived(points.slice(-12).reverse());
	const time = (t: number) => new Date(t * 1000).toLocaleTimeString();
</script>

<Page title={vm?.name ?? boot.vmName ?? 'Virtual machine'} description="Hardware and live usage" sticky_header={false}>
	{#snippet suffix()}
		{#if vm}<Status value={vm.state} states={vmStates} />{/if}
	{/snippet}

	{#if loading}
		<Flexbox justify="center" style="padding: 3rem 0;"><Loader /></Flexbox>
	{:else if !vm}
		<Section>
			<Card variant="danger" title="Virtual machine not found" description="It may have been deleted. Close this tab and refresh the tree." />
		</Section>
	{:else}
		<Section>
			<Flexbox gap="0.5rem" wrap="wrap">
				{#if vm.state !== 'running'}
					<Button variant="primary" disabled={!!vm.operation} onclick={() => run('vmm.start')}><Icon icon="play-fill" margin="right" />Start</Button>
				{:else}
					<Button disabled={!!vm.operation} onclick={() => run('vmm.shutdown')}><Icon icon="power" margin="right" />Shut down</Button>
					<Button transparent disabled={!!vm.operation} onclick={() => run('vmm.reboot')}><Icon icon="arrow-repeat" margin="right" />Restart</Button>
				{/if}
				{#if vm.state !== 'stopped'}
					<Button transparent onclick={() => run('vmm.stop')}><Icon icon="x-octagon" margin="right" />Power off</Button>
				{/if}
				<Button transparent onclick={() => run('vmm.connectGraphical')}><Icon icon="display" margin="right" />Console</Button>
				<Button transparent onclick={() => run('vmm.editVm')}><Icon icon="gear" margin="right" />Settings</Button>
				{#if vm.operation}<span class="operation">{OPERATION_LABEL[vm.operation as keyof typeof OPERATION_LABEL] ?? ''}</span>{/if}
			</Flexbox>
		</Section>

		<Section>
			<div class="tiles">
				<div class="tile"><span class="k">Uptime</span><span class="v">{running ? formatUptime(vm.uptimeSeconds) : '–'}</span></div>
				<div class="tile"><span class="k">Processors</span><span class="v">{vm.cpus ?? '–'}</span></div>
				<div class="tile"><span class="k">Memory</span><span class="v">{formatMemory(vm.memoryMB)}</span></div>
				<div class="tile"><span class="k">IP address</span><span class="v">{ips[0] ?? '–'}</span></div>
				<div class="tile"><span class="k">CPU</span><span class="v">{running ? formatPercent(latest?.cpu) : '–'}</span></div>
				<div class="tile">
					<span class="k">Disk I/O</span>
					<span class="v">{running && latest?.readBps != null ? `${formatRate(latest.readBps)} ↓ ${formatRate(latest.writeBps)} ↑` : '–'}</span>
				</div>
			</div>
		</Section>

		<Section title="Live usage" description={running ? 'Last 5 minutes, sampled every 2 seconds' : undefined}>
			{#if !caps?.stats}
				<Card variant="info" title="No live statistics" description="This hypervisor does not report usage for individual virtual machines." />
			{:else if !running}
				<Card variant="info" title="The virtual machine is {vmStates[vm.state].title?.toLowerCase()}" description="Live charts appear while it is running." />
			{:else}
				{#if statsError}<p class="error">Statistics unavailable: {statsError}</p>{/if}
				<div class="charts">
					<Card>
						<LineChart title="CPU" subtitle="of {vm.cpus ?? '?'} vCPU" series={[{ key: 'cpu', label: 'Usage' }]} data={cpuData} format={formatPercent} yMax={1} />
					</Card>
					<Card>
						<LineChart
							title="Memory"
							subtitle="of {formatMemory(vm.memoryMB)}"
							series={[{ key: 'memory', label: 'Used' }]}
							data={memoryData}
							format={(v) => (v === null ? '–' : formatBytes(v * 1024 * 1024))}
							yMax={memoryTop * 1.05}
							binary
						/>
					</Card>
					{#if hasDiskStats}
						<Card>
							<LineChart
								title="Disk throughput"
								series={[{ key: 'read', label: 'Read' }, { key: 'write', label: 'Write' }]}
								data={throughputData}
								format={formatRate}
								yFloor={64 * 1024}
								binary
							/>
						</Card>
						<Card>
							<LineChart
								title="Disk operations"
								series={[{ key: 'read', label: 'Read' }, { key: 'write', label: 'Write' }]}
								data={iopsData}
								format={formatIops}
								yFloor={10}
							/>
						</Card>
						<Card>
							<LineChart
								title="Disk latency"
								subtitle="average per request"
								series={[{ key: 'read', label: 'Read' }, { key: 'write', label: 'Write' }]}
								data={latencyData}
								format={formatLatency}
								yFloor={1}
							/>
						</Card>
					{/if}
				</div>
				<Flexbox justify="flex-end">
					<Button transparent onclick={() => (showTable = !showTable)}>
						<Icon icon="table" margin="right" />{showTable ? 'Hide data' : 'Show data'}
					</Button>
				</Flexbox>
				{#if showTable}
					<div class="scroll">
						<table class="grid">
							<thead>
								<tr><th>Time</th><th>CPU</th><th>Memory</th><th>Read</th><th>Write</th><th>Read IOPS</th><th>Write IOPS</th><th>Read latency</th><th>Write latency</th></tr>
							</thead>
							<tbody>
								{#each rows as p (p.t)}
									<tr>
										<td>{time(p.t)}</td><td>{formatPercent(p.cpu)}</td>
										<td>{p.memoryUsedMB === null ? '–' : formatBytes(p.memoryUsedMB * 1024 * 1024)}</td>
										<td>{formatRate(p.readBps)}</td><td>{formatRate(p.writeBps)}</td>
										<td>{formatIops(p.readIops)}</td><td>{formatIops(p.writeIops)}</td>
										<td>{formatLatency(p.readLatencyMs)}</td><td>{formatLatency(p.writeLatencyMs)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{/if}
		</Section>

		<Section title="Hardware">
			{#if detailsError}
				<Card variant="danger" title="Could not read the hardware" description={detailsError} />
			{:else if !details}
				<Card variant="info" title="No hardware details" description="This hypervisor does not report the hardware of individual virtual machines." />
			{:else}
				<div class="hardware">
					<Card title="Storage">
						{#if details.disks.length}
							<table class="grid">
								<thead><tr><th>Device</th><th>Image</th><th>Size</th><th>Bus</th><th></th></tr></thead>
								<tbody>
									{#each details.disks as d (d.id)}
										<tr>
											<td>{d.label}</td>
											<td class="path" title={d.path}>{d.path ?? (d.kind === 'cdrom' ? 'Empty' : '–')}</td>
											<td>{formatBytes(d.sizeBytes)}</td>
											<td>{(d.bus ?? '–').toUpperCase()}{d.format ? ` · ${d.format}` : ''}</td>
											<td class="actions">
												{#if d.kind === 'cdrom' && caps?.media}
													<Button transparent title="Change ISO" aria-label="Change ISO" onclick={() => run('vmm.changeMedia')}><Icon icon="folder2-open" /></Button>
													{#if d.path}
														<Button transparent title="Eject" aria-label="Eject {d.label}" onclick={() => run('vmm.ejectMedia')}><Icon icon="eject" /></Button>
													{/if}
												{/if}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{:else}
							<p class="muted">No disks.</p>
						{/if}
					</Card>
					<Card title="Network">
						{#if details.nics.length}
							<table class="grid">
								<thead><tr><th>Adapter</th><th>Attached to</th><th>MAC</th><th>IP addresses</th></tr></thead>
								<tbody>
									{#each details.nics as n (n.id)}
										<tr>
											<td>{n.label}{n.model ? ` (${n.model})` : ''}</td>
											<td>{n.network ?? '–'}</td>
											<td class="mono">{n.mac ?? '–'}</td>
											<td>{n.ipAddresses?.length ? n.ipAddresses.join(', ') : running ? 'Unknown (needs a guest agent)' : '–'}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{:else}
							<p class="muted">No network adapters.</p>
						{/if}
						{#if details.forwards.length}
							<h4>Port forwards</h4>
							<table class="grid">
								<thead><tr><th>Protocol</th><th>Host</th><th>Guest</th></tr></thead>
								<tbody>
									{#each details.forwards as f (`${f.protocol}${f.hostPort}`)}
										<tr><td>{f.protocol.toUpperCase()}</td><td>{f.hostAddress ?? '*'}:{f.hostPort}</td><td>{f.guestPort}</td></tr>
									{/each}
								</tbody>
							</table>
						{/if}
					</Card>
					{#if details.devices.length}
						<Card title="Devices">
							<table class="grid">
								<thead><tr><th>Type</th><th>Device</th><th>Address</th><th>ID</th></tr></thead>
								<tbody>
									{#each details.devices as d (d.id)}
										<tr><td>{d.kind.toUpperCase()}</td><td>{d.label}</td><td class="mono">{d.address ?? '–'}</td><td class="mono">{d.description ?? '–'}</td></tr>
									{/each}
								</tbody>
							</table>
						</Card>
					{/if}
				</div>
			{/if}
		</Section>
	{/if}
</Page>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 0.75rem;
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.6rem 0.8rem;
		border-radius: 6px;
		background: var(--vscode-editorWidget-background, transparent);
		border: 1px solid var(--vscode-widget-border, transparent);
		min-width: 0;
	}
	.k {
		color: var(--vscode-descriptionForeground);
		font-size: 0.85em;
	}
	.v {
		font-size: 1.15em;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
		gap: 1rem;
		margin-bottom: 0.5rem;
	}
	.hardware {
		display: grid;
		gap: 1rem;
	}
	.scroll {
		overflow-x: auto;
	}
	.grid {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.95em;
	}
	.grid th {
		text-align: left;
		font-weight: 600;
		color: var(--vscode-descriptionForeground);
		padding: 0.3rem 0.6rem 0.3rem 0;
	}
	.grid td {
		padding: 0.3rem 0.6rem 0.3rem 0;
		border-top: 1px solid var(--vscode-widget-border, #8883);
		font-variant-numeric: tabular-nums;
	}
	.path {
		max-width: 28ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mono {
		font-family: var(--vscode-editor-font-family, monospace);
	}
	.actions {
		white-space: nowrap;
		text-align: right;
	}
	.muted,
	.operation {
		color: var(--vscode-descriptionForeground);
	}
	.error {
		color: var(--vscode-errorForeground);
	}
	h4 {
		margin: 1rem 0 0.25rem;
	}
</style>
