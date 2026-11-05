<script lang="ts">
	import { onMount } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import { WINDOW_SECONDS, niceTicks } from '../../../shared/metrics';
	import { seriesColor, type SeriesKey } from '../chartPalette';
	import { currentThemeKind, onThemeChange } from '../theme-sync';

	interface Props {
		title: string;
		subtitle?: string;
		series: Array<{ key: SeriesKey; label: string }>;
		/** Column-major: `[times (s), ...one column per series]`, `null` = gap. */
		data: Array<Array<number | null>>;
		/** Formats values for the axis, the legend and the hover readout. */
		format: (value: number | null) => string;
		/** Fixed top of the y axis (e.g. 1 for a fraction); otherwise it follows the data. */
		yMax?: number;
		/** Smallest top of the y axis so an idle chart does not zoom into noise. */
		yFloor?: number;
		/** Byte quantities: tick steps are powers of two (512 MB, 1 GB, …). */
		binary?: boolean;
		height?: number;
	}

	let { title, subtitle, series, data, format, yMax, yFloor = 1, binary = false, height = 150 }: Props = $props();

	let host: HTMLDivElement;
	let plot: uPlot | undefined;
	let hoverIndex = $state<number | null>(null);
	let kind = $state(currentThemeKind());

	const times = $derived(data[0] ?? []);
	const shownIndex = $derived(hoverIndex ?? (times.length ? times.length - 1 : null));
	const shownTime = $derived(shownIndex !== null && times[shownIndex] !== undefined ? new Date((times[shownIndex] as number) * 1000).toLocaleTimeString() : '');
	const hovering = $derived(hoverIndex !== null);

	function css(name: string, fallback: string): string {
		return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
	}

	function build() {
		plot?.destroy();
		const text = css('--vscode-descriptionForeground', '#888');
		const surface = css('--vscode-editor-background', '#1e1e1e');
		const grid = { stroke: '#8883', width: 1 };
		const lastTime = () => {
			const t = plot?.data[0] ?? data[0] ?? [];
			return (t[t.length - 1] as number | undefined) ?? Date.now() / 1000;
		};
		plot = new uPlot(
			{
				width: host.clientWidth || 400,
				height,
				padding: [8, 8, 0, 0],
				legend: { show: false },
				cursor: {
					drag: { x: false, y: false },
					points: { size: 9, width: 2, stroke: () => surface, fill: (_u: uPlot, i: number) => seriesColor(series[i - 1]?.key ?? 'cpu', kind) }
				},
				scales: {
					x: { time: true, range: () => [lastTime() - WINDOW_SECONDS, lastTime()] },
					y: {
						range: (_u, _min, max) => [0, yMax ?? Math.max(yFloor, (max || 0) * 1.2)]
					}
				},
				axes: [
					{
						stroke: text,
						grid,
						ticks: { show: false },
						font: '11px sans-serif',
						size: 24,
						// One line per label (the default wraps date and time and gets clipped).
						values: (_u, splits) => splits.map((t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))
					},
					{
						stroke: text,
						grid,
						ticks: { show: false },
						font: '11px sans-serif',
						size: 64,
						splits: (_u, _axis, _min, max) => niceTicks(max, binary),
						values: (_u, splits) => splits.map((v) => format(v))
					}
				],
				series: [
					{},
					...series.map((s) => {
						const color = seriesColor(s.key, kind);
						return { label: s.label, stroke: color, width: 2, fill: `${color}1a`, points: { show: false }, spanGaps: false };
					})
				],
				hooks: {
					// uPlot starts with its cursor on the plot: park it outside so no stray line shows.
					ready: [(u) => u.setCursor({ left: -10, top: -10 })],
					setCursor: [
						(u) => {
							hoverIndex = u.cursor.idx ?? null;
						}
					]
				}
			},
			data as uPlot.AlignedData,
			host
		);
	}

	onMount(() => {
		build();
		const resize = new ResizeObserver(() => plot?.setSize({ width: host.clientWidth, height }));
		resize.observe(host);
		const stopTheme = onThemeChange((next) => {
			kind = next;
			build();
		});
		return () => {
			resize.disconnect();
			stopTheme();
			plot?.destroy();
		};
	});

	$effect(() => {
		// Re-run when the data changes.
		const next = data as uPlot.AlignedData;
		plot?.setData(next);
	});
</script>

<figure class="chart" aria-label="{title}: {series.map((s) => s.label).join(', ')}">
	<figcaption>
		<span class="title">{title}</span>
		{#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
		<span class="time" class:live={!hovering}>{hovering ? shownTime : 'Now'}</span>
	</figcaption>
	<ul class="legend">
		{#each series as s, i (s.key)}
			<li>
				<span class="swatch" style="background: {seriesColor(s.key, kind)}"></span>
				<span class="label">{s.label}</span>
				<span class="value">{shownIndex === null ? '–' : format((data[i + 1]?.[shownIndex] as number | null | undefined) ?? null)}</span>
			</li>
		{/each}
	</ul>
	<div class="plot" bind:this={host} onmouseleave={() => (hoverIndex = null)} role="img"></div>
</figure>

<style>
	.chart {
		margin: 0;
		min-width: 0;
	}
	figcaption {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.25rem;
	}
	.title {
		font-weight: 600;
	}
	.subtitle,
	.time {
		color: var(--vscode-descriptionForeground);
		font-size: 0.85em;
	}
	.time {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		list-style: none;
		margin: 0 0 0.25rem;
		padding: 0;
		font-size: 0.9em;
	}
	.legend li {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex: none;
	}
	.label {
		color: var(--vscode-descriptionForeground);
	}
	.value {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.plot {
		width: 100%;
		min-height: 1px;
	}
	/* uPlot's own stylesheet sets a white background on the cursor; the theme decides here. */
	.plot :global(.u-over) {
		cursor: crosshair;
	}
	.plot :global(.u-cursor-x),
	.plot :global(.u-cursor-y) {
		border-color: var(--vscode-descriptionForeground) !important;
	}
</style>
