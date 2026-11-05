<script lang="ts">
	/** A tiny line of the last values (0..1) with the latest value as a dot. No axes: the number beside it says the rest. */
	let { values, color, width = 72, height = 22 }: { values: number[]; color: string; width?: number; height?: number } = $props();

	const pad = 3;
	const points = $derived(
		values.map((v, i) => {
			const x = values.length === 1 ? width - pad : pad + (i * (width - 2 * pad)) / (values.length - 1);
			const y = height - pad - Math.max(0, Math.min(1, v)) * (height - 2 * pad);
			return [x, y] as const;
		})
	);
	const line = $derived(points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
	const last = $derived(points[points.length - 1]);
</script>

{#if points.length}
	<svg {width} {height} viewBox="0 0 {width} {height}" role="img" aria-label="CPU usage over the last samples">
		<polyline points={line} fill="none" stroke={color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
		{#if last}<circle cx={last[0]} cy={last[1]} r="3" fill={color} stroke="var(--vscode-editor-background)" stroke-width="2" />{/if}
	</svg>
{:else}
	<span class="none">–</span>
{/if}

<style>
	svg {
		display: block;
		overflow: visible;
	}
	.none {
		color: var(--vscode-descriptionForeground);
	}
</style>
