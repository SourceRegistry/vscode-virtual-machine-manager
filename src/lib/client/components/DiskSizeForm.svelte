<script lang="ts">
	import { onMount } from 'svelte';
	import Flexbox from '#lib/client-lib/components/layout/Flexbox.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import type { DiskSizeAnswer, DiskSizeRequest } from '../../../shared/protocol';
	import { defaultUnit, inUnit, nextWhole, sizeBytes, sizeProblem, UNIT_BYTES, type SizeUnit } from '../../../shared/disks';
	import { formatBytes } from '../../../shared/metrics';
	import { request } from '../rpc/bridge';

	/**
	 * Growing a disk: its new size. Adding one: an empty disk (size and image format) or an existing image file
	 * (copied, or used where it is). A number field that steps by 1 MB or GB, and a unit. Shown in a modal on the
	 * details page; the parent keys it by `askId`, so the question is fixed.
	 */
	let { ask, onsubmit, oncancel }: { ask: DiskSizeRequest; onsubmit: (answer: DiskSizeAnswer) => Promise<void>; oncancel: () => void } = $props();

	// The parent re-creates the form for every question (`{#key askId}`), so reading `ask` once is right.
	// svelte-ignore state_referenced_locally
	const { mode, currentBytes: current, formats = ['qcow2'], attach } = ask;
	const grow = mode === 'grow';
	const canEmpty = grow || formats.length > 0;

	let source = $state<'empty' | 'file'>(canEmpty ? 'empty' : 'file');
	let unit = $state<SizeUnit>(grow ? defaultUnit(current) : 'GB');
	let value = $state<number | null>(grow && current !== undefined ? nextWhole(current, defaultUnit(current)) : 20);
	let format = $state<'qcow2' | 'raw'>(formats[0] ?? 'qcow2');
	let path = $state('');
	let copy = $state(attach?.modes.includes('copy') ?? true);
	let busy = $state(false);
	let error = $state<string | undefined>();
	let input = $state<HTMLInputElement | undefined>();
	let pathInput = $state<HTMLInputElement | undefined>();

	const problem = $derived(
		source === 'file' ? (/^(\/|[A-Za-z]:[\\/])/.test(path.trim()) ? undefined : path.trim() ? 'Give the full path of the image.' : 'Choose an image file.') : sizeProblem(value, unit, current)
	);
	const bytes = $derived(source === 'empty' && !problem ? sizeBytes(value!, unit) : undefined);
	/** The smallest value the field accepts: just above the current size, or 1 MB. */
	const min = $derived(grow && current !== undefined ? inUnit(current, unit) : unit === 'MB' ? 1 : 0.001);
	const fileName = $derived(path.trim().split(/[\\/]/).pop() ?? '');

	/** Keeps the size when the unit changes: 21 GB becomes 21504 MB. */
	function changeUnit(next: SizeUnit) {
		if (value !== null && Number.isFinite(value)) value = inUnit(value * UNIT_BYTES[unit], next);
		unit = next;
	}

	async function browse() {
		const picked = await request('browseDiskImage').catch(() => undefined);
		if (picked) path = picked;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (problem || busy) return;
		busy = true;
		error = undefined;
		try {
			await onsubmit(source === 'file' ? { file: { path: path.trim(), copy } } : { bytes: bytes!, ...(grow ? {} : { format }) });
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	function focusField() {
		const field = source === 'file' ? pathInput : input;
		field?.focus();
		field?.select();
	}

	onMount(() => {
		// After the modal has opened (opening a dialog moves the focus itself).
		const timer = setTimeout(focusField, 50);
		return () => clearTimeout(timer);
	});
</script>

<form class="size-form" onsubmit={submit}>
	{#if ask.note}
		<p class="muted"><Icon icon="info-circle" margin="right" />{ask.note}</p>
	{/if}

	{#if !grow && attach && canEmpty}
		<div class="sources" role="radiogroup" aria-label="New disk">
			<label class:selected={source === 'empty'}>
				<input type="radio" name="source" value="empty" bind:group={source} onchange={() => setTimeout(focusField)} />
				<Icon icon="hdd" margin="right" />Empty disk
			</label>
			<label class:selected={source === 'file'}>
				<input type="radio" name="source" value="file" bind:group={source} onchange={() => setTimeout(focusField)} />
				<Icon icon="file-earmark-arrow-up" margin="right" />Image file
			</label>
		</div>
	{/if}

	{#if source === 'empty'}
		{#if grow && current !== undefined}
			<p class="now">Now <strong>{formatBytes(current)}</strong>. Disks can only grow.</p>
		{/if}
		<label class="field">
			<span>{grow ? 'New size' : 'Size'}</span>
			<span class="row">
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
			<fieldset class="choices">
				<legend>Image format</legend>
				<label><input type="radio" name="format" value="qcow2" bind:group={format} /> <strong>qcow2</strong> <span class="muted">takes space as the guest writes; allows snapshots</span></label>
				<label><input type="radio" name="format" value="raw" bind:group={format} /> <strong>raw</strong> <span class="muted">takes its full size at once; a little faster</span></label>
			</fieldset>
		{/if}

		{#if grow}
			<p class="muted">Afterwards, grow the partition and file system inside the guest to use the space.</p>
		{/if}
	{:else if attach}
		<label class="field">
			<span>Image file <span class="muted">(qcow2, raw, VMDK, VHDX, VHD, VDI)</span></span>
			<span class="row">
				<input
					bind:this={pathInput}
					class="path"
					type="text"
					bind:value={path}
					placeholder={attach.browse ? 'Choose a file…' : 'Path on the host, e.g. /var/lib/images/disk.qcow2'}
					aria-label="Path of the image"
					aria-invalid={!!path && !!problem}
					spellcheck="false"
				/>
				{#if attach.browse}
					<Button type="button" onclick={browse} disabled={busy}><Icon icon="folder2-open" margin="right" />Browse…</Button>
				{/if}
			</span>
		</label>
		{#if path && problem}<p class="hint problem" role="alert">{problem}</p>{/if}

		{#if attach.modes.length > 1}
			<fieldset class="choices">
				<legend>Use the file</legend>
				<label><input type="radio" name="copy" value={true} bind:group={copy} /> <strong>Copy it</strong> <span class="muted">next to the machine's disks; the original stays as it is</span></label>
				<label><input type="radio" name="copy" value={false} bind:group={copy} /> <strong>Use it where it is</strong> <span class="muted">the machine writes to this file</span></label>
			</fieldset>
		{:else}
			<p class="muted">{attach.modes[0] === 'copy' ? 'A copy is attached; the original stays as it is.' : 'The machine uses the file where it is and writes to it.'}</p>
		{/if}
	{/if}

	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<Flexbox justify="flex-end" gap="0.5rem">
		<Button type="button" transparent disabled={busy} onclick={oncancel}>Cancel</Button>
		<Button type="submit" variant="primary" disabled={!!problem} loading={busy}>
			{#if grow}
				<Icon icon="arrows-angle-expand" margin="right" />Grow
			{:else if source === 'file'}
				<Icon icon="paperclip" margin="right" />Attach{fileName ? ` ${fileName}` : ''}
			{:else}
				<Icon icon="plus-lg" margin="right" />Add Disk
			{/if}
		</Button>
	</Flexbox>
</form>

<style>
	.size-form {
		display: grid;
		gap: 0.6rem;
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
	.row {
		display: flex;
		gap: 0.4rem;
	}
	input[type='number'],
	input[type='text'],
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
	input.path {
		flex: 1;
		min-width: 0;
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
	.choices {
		border: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.3rem;
	}
	.choices legend {
		padding: 0;
		margin-bottom: 0.25rem;
	}
	.sources {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem;
	}
	.sources label {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--vscode-widget-border, #8886);
		border-radius: 4px;
		cursor: pointer;
	}
	.sources label.selected {
		border-color: var(--vscode-focusBorder);
		background: var(--vscode-list-activeSelectionBackground, transparent);
		color: var(--vscode-list-activeSelectionForeground, inherit);
	}
	.sources label:focus-within {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 1px;
	}
	.sources input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
</style>
