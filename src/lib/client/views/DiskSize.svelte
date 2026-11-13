<script lang="ts">
	import { onMount } from 'svelte';
	import Page from '#lib/client-lib/components/layout/Page.svelte';
	import Section from '#lib/client-lib/components/layout/Section.svelte';
	import Flexbox from '#lib/client-lib/components/layout/Flexbox.svelte';
	import Card from '#lib/client-lib/components/display/Card.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import type { BootData } from '../../../shared/protocol';
	import { defaultUnit, inUnit, nextWhole, sizeBytes, sizeProblem, UNIT_BYTES, type SizeUnit } from '../../../shared/disks';
	import { formatBytes } from '../../../shared/metrics';
	import { request } from '../rpc/bridge';

	let { boot }: { boot: BootData } = $props();

	// The question is fixed for the life of the page.
	// svelte-ignore state_referenced_locally
	const ask = boot.diskSize!;
	const grow = ask.mode === 'grow';
	const current = ask.currentBytes;
	const formats = ask.formats ?? ['qcow2'];

	let unit = $state<SizeUnit>(grow ? defaultUnit(current) : 'GB');
	let value = $state<number | null>(grow && current !== undefined ? nextWhole(current, defaultUnit(current)) : 20);
	let format = $state<'qcow2' | 'raw'>(formats[0]!);
	let busy = $state(false);
	let error = $state<string | undefined>();
	let input = $state<HTMLInputElement | undefined>();

	const problem = $derived(sizeProblem(value, unit, current));
	const bytes = $derived(problem ? undefined : sizeBytes(value!, unit));
	/** The smallest value the field accepts: just above the current size, or 1 MB. */
	const min = $derived(grow && current !== undefined ? inUnit(current, unit) : unit === 'MB' ? 1 : 0.001);

	/** Keeps the size when the unit changes: 21 GB becomes 21504 MB. */
	function changeUnit(next: SizeUnit) {
		if (value !== null && Number.isFinite(value)) value = inUnit(value * UNIT_BYTES[unit], next);
		unit = next;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (bytes === undefined || busy) return;
		busy = true;
		error = undefined;
		try {
			await request('submitDiskSize', { bytes, ...(grow ? {} : { format }) });
		} catch (e) {
			error = (e as Error).message;
			busy = false;
		}
	}

	onMount(() => {
		input?.focus();
		input?.select();
	});
</script>

<Page title={grow ? `Grow ${ask.diskLabel ?? 'disk'}` : 'Add a disk'} description={ask.vmName} sticky_header={false}>
	<Section>
		<Card>
			<form class="size-form" onsubmit={submit}>
				{#if grow && current !== undefined}
					<p class="now">Now <strong>{formatBytes(current)}</strong>. Disks can only grow.</p>
				{/if}
				<label class="field">
					<span>{grow ? 'New size' : 'Size'}</span>
					<span class="size">
						<input bind:this={input} type="number" step="any" {min} max={inUnit(64 * 1024 ** 4, unit)} bind:value aria-label="Size in {unit}" aria-invalid={!!problem} required />
						<select value={unit} onchange={(e) => changeUnit((e.currentTarget as HTMLSelectElement).value as SizeUnit)} aria-label="Unit">
							<option value="MB">MB</option>
							<option value="GB">GB</option>
						</select>
					</span>
				</label>
				<p class="hint" class:problem={!!problem} role={problem ? 'alert' : undefined}>
					{#if problem}
						{problem}
					{:else if grow && current !== undefined && bytes !== undefined}
						{formatBytes(current)} → {formatBytes(bytes)} (+{formatBytes(bytes - current)})
					{:else if bytes !== undefined}
						{formatBytes(bytes)}
					{/if}
				</p>
				<p class="muted">The arrows step by 1 {unit}; type any value, also with decimals. Switch to MB for small sizes.</p>

				{#if !grow && formats.length > 1}
					<fieldset class="formats">
						<legend>Image format</legend>
						<label><input type="radio" name="format" value="qcow2" bind:group={format} /> <strong>qcow2</strong> <span class="muted">takes space as the guest writes; allows snapshots</span></label>
						<label><input type="radio" name="format" value="raw" bind:group={format} /> <strong>raw</strong> <span class="muted">takes its full size at once; a little faster</span></label>
					</fieldset>
				{/if}

				{#if grow}
					<p class="muted">Afterwards, grow the partition and file system inside the guest to use the space.</p>
				{/if}
				{#if error}<p class="error" role="alert">{error}</p>{/if}

				<Flexbox justify="flex-end" gap="0.5rem">
					<Button type="button" transparent disabled={busy} onclick={() => void request('cancelDiskSize')}>Cancel</Button>
					<Button type="submit" variant="primary" disabled={!!problem} loading={busy}>
						<Icon icon={grow ? 'arrows-angle-expand' : 'plus-lg'} margin="right" />{grow ? 'Grow' : 'Add Disk'}
					</Button>
				</Flexbox>
			</form>
		</Card>
	</Section>
</Page>

<style>
	.size-form {
		display: grid;
		gap: 0.6rem;
		max-width: 32rem;
	}
	.now,
	.hint,
	.muted,
	.error {
		margin: 0;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.size {
		display: flex;
		gap: 0.4rem;
	}
	input[type='number'],
	select {
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8886));
		border-radius: 3px;
		padding: 0.3rem 0.45rem;
		font: inherit;
	}
	input[type='number'] {
		width: 10rem;
	}
	input[aria-invalid='true'] {
		border-color: var(--vscode-inputValidation-errorBorder, #be1100);
	}
	.hint {
		font-variant-numeric: tabular-nums;
	}
	.problem,
	.error {
		color: var(--vscode-errorForeground);
	}
	.muted {
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
	}
	.formats {
		border: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.3rem;
	}
	.formats legend {
		padding: 0;
		margin-bottom: 0.25rem;
	}
</style>
