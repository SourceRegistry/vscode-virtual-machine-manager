<script lang="ts">
	/**
	 * A thin horizontal gauge: label on the left, value on the right, fill in between.
	 * The fill color follows the entity (cpu, memory); `over` flags values above 100% with the
	 * warning status color plus the text, so the state never relies on color alone.
	 */
	let {
		label,
		value,
		fraction,
		color,
		over = false
	}: { label: string; value: string; fraction: number | undefined; color: string; over?: boolean } = $props();

	const clamped = $derived(Math.max(0, Math.min(1, fraction ?? 0)));
</script>

<div class="meter">
	<div class="row">
		<span class="label">{label}</span>
		<span class="value" class:over>{value}{over ? ' · overcommitted' : ''}</span>
	</div>
	<div class="track" role="meter" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(clamped * 100)} aria-valuetext={value}>
		{#if fraction !== undefined}
			<div class="fill" style="width: {clamped * 100}%; background: {over ? 'var(--color-warning, var(--vscode-editorWarning-foreground, #cca700))' : color}"></div>
		{/if}
	</div>
</div>

<style>
	.meter {
		min-width: 0;
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.9em;
		margin-bottom: 0.2rem;
	}
	.label {
		color: var(--vscode-descriptionForeground);
	}
	.value {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		text-align: right;
	}
	.value.over {
		color: var(--color-warning, var(--vscode-editorWarning-foreground, #cca700));
	}
	.track {
		height: 8px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		border-radius: 4px;
		transition: width 0.4s ease;
	}
</style>
