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
	import { formatMemory, formatUptime, type Capabilities, type PassthroughInfo, type VmDetails, type VmInfo, type VmStats } from '@vmm/sdk';
	import type { BootData, OverviewCommand } from '../../../shared/protocol';
	import { originLabel } from '../../../shared/origin';
	import { browserUrl, GUEST_HOST_ADDRESS, sshCommand } from '../../../shared/forwards';
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

	// Host devices (passthrough). Loaded on demand: listing USB can take a second on some hosts.
	let passthrough = $state<PassthroughInfo | undefined>();
	let passthroughError = $state<string | undefined>();
	let passthroughBusy = $state<string | undefined>();
	let passthroughLoaded = $state(false);

	async function loadPassthrough() {
		passthroughBusy = 'refresh';
		try {
			passthrough = await request('getPassthrough');
			passthroughError = undefined;
		} catch (error) {
			passthroughError = (error as Error).message;
		} finally {
			passthroughBusy = undefined;
			passthroughLoaded = true;
		}
	}

	async function changeDevice(deviceId: string, action: 'attach' | 'detach') {
		passthroughBusy = deviceId;
		actionError = undefined;
		try {
			const { changed } = await request('changePassthrough', { deviceId, action });
			if (changed) await Promise.all([loadPassthrough(), loadDetails()]);
		} catch (error) {
			actionError = (error as Error).message;
		} finally {
			passthroughBusy = undefined;
		}
	}
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

	let actionError = $state<string | undefined>();

	// Port forwards
	let newProtocol = $state<'tcp' | 'udp'>('tcp');
	let newHostPort = $state('');
	let newGuestPort = $state('');
	let forwardBusy = $state(false);
	let addingForward = $state(false);
	const canForward = $derived(!!caps?.forwards);

	async function forwardCall(call: () => Promise<unknown>) {
		forwardBusy = true;
		actionError = undefined;
		try {
			await call();
			await loadDetails();
		} catch (error) {
			actionError = (error as Error).message;
		} finally {
			forwardBusy = false;
		}
	}

	function addForward(event: SubmitEvent) {
		event.preventDefault();
		const forward = { protocol: newProtocol, hostPort: Number(newHostPort), guestPort: Number(newGuestPort) };
		void forwardCall(async () => {
			await request('addForward', { forward });
			newHostPort = '';
			newGuestPort = '';
			addingForward = false;
		});
	}

	function cancelForward() {
		addingForward = false;
		newHostPort = '';
		newGuestPort = '';
	}

	function run(command: OverviewCommand) {
		if (!boot.ref) return;
		actionError = undefined;
		request('runCommand', { command, ref: boot.ref }).catch((error: Error) => (actionError = error.message));
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
		{#if vm}
			<Flexbox gap="0.6rem" align="center">
				{#if originLabel(vm)}
					<span class="badge" title={vm.controllable === false ? 'Started outside VM Manager without a control socket: it can only be observed and powered off.' : vm.origin === 'adopted' ? 'Started outside VM Manager; attached through its control socket.' : 'Created from existing disks or definitions.'}>{originLabel(vm)}</span>
				{/if}
				<Status value={vm.state} states={vmStates} />
			</Flexbox>
		{/if}
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
				{:else if vm.controllable !== false}
					<Button disabled={!!vm.operation} onclick={() => run('vmm.shutdown')}><Icon icon="power" margin="right" />Shut down</Button>
					<Button transparent disabled={!!vm.operation} onclick={() => run('vmm.reboot')}><Icon icon="arrow-repeat" margin="right" />Restart</Button>
				{/if}
				{#if vm.state !== 'stopped'}
					<Button transparent onclick={() => run('vmm.stop')}><Icon icon="x-octagon" margin="right" />Power off</Button>
				{/if}
				{#if !vm.consoles || vm.consoles.length}
					<Button transparent onclick={() => run('vmm.connectGraphical')}><Icon icon="display" margin="right" />Console</Button>
				{/if}
				<Button transparent onclick={() => run('vmm.editVm')}><Icon icon="gear" margin="right" />Settings</Button>
				{#if actionError}<span class="error">{actionError}</span>{/if}
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
											<td>{n.ipAddresses?.length ? n.ipAddresses.join(', ') : running ? 'Unknown (needs a guest agent; user networking usually uses 10.0.2.15)' : '–'}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{:else}
							<p class="muted">No network adapters.</p>
						{/if}
						{#if details.forwards.length || canForward}
							<div class="subhead">
								<span>Port forwards</span>
								{#if canForward}
									<Button transparent title="Add port forward" aria-label="Add port forward" disabled={addingForward} onclick={() => (addingForward = true)}><Icon icon="plus-lg" /></Button>
								{/if}
							</div>
							<table class="grid">
								<thead><tr><th>Protocol</th><th>Host (listens)</th><th class="arrow" aria-hidden="true"></th><th>Guest (receives)</th><th></th></tr></thead>
								<tbody>
									{#each details.forwards as f (`${f.protocol}${f.hostAddress}${f.hostPort}`)}
										<tr>
											<td>{f.protocol.toUpperCase()}</td>
											<td class="mono">{f.hostAddress ?? '*'}:{f.hostPort}</td>
											<td class="arrow" aria-label="forwarded to">→</td>
											<td class="mono">{f.guestPort}</td>
											<td class="actions">
												{#if sshCommand(f)}
													<Button transparent title="Copy ssh command" aria-label="Copy ssh command for port {f.hostPort}" onclick={() => forwardCall(() => request('forwardAction', { action: 'copySsh', forward: f }))}><Icon icon="terminal" /></Button>
												{/if}
												{#if browserUrl(f)}
													<Button transparent title="Open in browser" aria-label="Open port {f.hostPort} in browser" onclick={() => forwardCall(() => request('forwardAction', { action: 'open', forward: f }))}><Icon icon="box-arrow-up-right" /></Button>
												{/if}
												{#if canForward}
													<Button transparent disabled={forwardBusy} title="Remove forward" aria-label="Remove forward {f.hostPort}" onclick={() => forwardCall(() => request('removeForward', { forward: f }))}><Icon icon="trash" /></Button>
												{/if}
											</td>
										</tr>
									{/each}
									{#if addingForward}
										<tr class="new-row">
											<td>
												<select form="forward-form" bind:value={newProtocol} aria-label="Protocol">
													<option value="tcp">TCP</option>
													<option value="udp">UDP</option>
												</select>
											</td>
											<td><input form="forward-form" type="number" min="1" max="65535" placeholder="Host port" aria-label="Host port" bind:value={newHostPort} required /></td>
											<td class="arrow" aria-hidden="true">→</td>
											<td><input form="forward-form" type="number" min="1" max="65535" placeholder="Guest port" aria-label="Guest port" bind:value={newGuestPort} required /></td>
											<td class="actions">
												<Button transparent type="submit" form="forward-form" disabled={forwardBusy} title="Add" aria-label="Confirm port forward"><Icon icon="check-lg" /></Button>
												<Button transparent title="Cancel" aria-label="Cancel" onclick={cancelForward}><Icon icon="x-lg" /></Button>
											</td>
										</tr>
									{:else if !details.forwards.length}
										<tr class="empty-row"><td colspan="5" class="empty">No port forwards. Use + to forward a host port to the guest, e.g. SSH.</td></tr>
									{/if}
								</tbody>
							</table>
							<form id="forward-form" onsubmit={addForward}></form>
							<p class="muted hint">Forwards listen on 127.0.0.1 only. From the guest, the host is reachable at <span class="mono">{GUEST_HOST_ADDRESS}</span>.</p>
						{/if}
					</Card>
					{#if caps?.passthrough}
						<Card title="Host devices">
							{#snippet header()}
								<Button transparent title="Refresh the list of host devices" aria-label="Refresh host devices" disabled={passthroughBusy !== undefined} onclick={loadPassthrough}><Icon icon="arrow-clockwise" /></Button>
							{/snippet}
							{#if !passthroughLoaded && !passthroughBusy}
								<div class="empty">
									<p>Give a USB or PCI device of this computer to the virtual machine.</p>
									<span class="compact"><Button transparent onclick={loadPassthrough}><Icon icon="usb-symbol" margin="right" />Show host devices</Button></span>
								</div>
							{:else if passthroughBusy === 'refresh' && !passthrough}
								<Flexbox justify="center" style="padding: 1rem 0;"><Loader /></Flexbox>
							{:else if passthroughError}
								<p class="error">{passthroughError}</p>
							{:else if passthrough}
								{#if !passthrough.usb.supported || !passthrough.pci.supported || passthrough.pci.experimental}
									<ul class="notes">
										{#if !passthrough.usb.supported}<li><Icon icon="info-circle" /><span>{passthrough.usb.reason}</span></li>{/if}
										{#if !passthrough.pci.supported}<li><Icon icon="info-circle" /><span>{passthrough.pci.reason}</span></li>{/if}
										{#if passthrough.pci.supported && passthrough.pci.experimental}<li><Icon icon="exclamation-triangle" /><span>PCI passthrough (VFIO) is experimental: not validated on every host.</span></li>{/if}
									</ul>
								{/if}
								{#if passthrough.devices.length}
									<div class="scroll devices">
										<table class="grid">
											<thead><tr><th>Type</th><th>Device</th><th>Address</th><th></th></tr></thead>
											<tbody>
												{#each passthrough.devices as d (d.id)}
													<tr>
														<td>{d.kind.toUpperCase()}</td>
														<td>{d.label}{#if d.detail}<div class="muted small">{d.detail}</div>{/if}</td>
														<td class="mono">{d.address}</td>
														<td class="actions">
															{#if d.attached}
																<Button transparent disabled={passthroughBusy !== undefined} onclick={() => changeDevice(d.id, 'detach')}>Detach</Button>
															{:else if d.unavailable}
																<span class="muted small" title={d.unavailable}>Unavailable</span>
															{:else}
																<Button transparent disabled={passthroughBusy !== undefined} onclick={() => changeDevice(d.id, 'attach')}>Attach</Button>
															{/if}
														</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								{:else if passthrough.usb.supported || passthrough.pci.supported}
									<p class="empty">No devices found.</p>
								{/if}
							{/if}
						</Card>
					{/if}
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
	.badge {
		padding: 0.1rem 0.55rem;
		border-radius: 999px;
		font-size: 0.8em;
		line-height: 1.4;
		color: var(--vscode-badge-foreground, inherit);
		background: var(--vscode-badge-background, #8883);
		white-space: nowrap;
	}
	.muted,
	.operation {
		color: var(--vscode-descriptionForeground);
	}
	.error {
		color: var(--vscode-errorForeground);
	}
	.subhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 1rem 0 0.15rem;
		font-weight: 600;
		color: var(--vscode-descriptionForeground);
	}
	.arrow {
		width: 1.5rem;
		text-align: center;
		color: var(--vscode-descriptionForeground);
	}
	/* Icon-only buttons in these rows: compact, so they sit level with the text. */
	.subhead :global(button),
	.actions :global(button) {
		padding: 0.1rem 0.3rem;
		min-height: 0;
		line-height: 1;
	}
	.subhead :global(.bi),
	.actions :global(.bi) {
		font-size: 0.95em;
	}
	.new-row input,
	.new-row select {
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8886));
		border-radius: 3px;
		padding: 0.2rem 0.4rem;
		font: inherit;
	}
	.new-row input {
		width: 7rem;
	}
	.empty {
		text-align: center;
		color: var(--vscode-descriptionForeground);
		padding: 0.75rem 0;
	}
	.empty p {
		margin: 0 0 0.4rem;
	}
	.notes {
		list-style: none;
		margin: 0 0 0.5rem;
		padding: 0;
		display: grid;
		gap: 0.35rem;
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
	}
	.notes li {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
	}
	.compact :global(button) {
		padding: 0.15rem 0.6rem;
		min-height: 0;
		font-size: 0.9em;
	}
	.small {
		font-size: 0.85em;
	}
	.devices {
		max-height: 22rem;
		overflow-y: auto;
	}
	.hint {
		margin: 0.5rem 0 0;
		font-size: 0.9em;
	}
</style>
