<script lang="ts">
	import Input from '#lib/client-lib/components/form/Input.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import type { FieldSchema, FieldValues } from '@vmm/sdk';
	import { toasts } from '#lib/client-lib/components/toast/index.js';
	import { request } from '../rpc/bridge';

	/**
	 * Renders provider field schemas with client-lib inputs. The same schemas drive the native
	 * multi-step input on the host, so providers describe their fields once.
	 */
	let {
		fields,
		values = $bindable(),
		disabled = false,
		onejected
	}: { fields: FieldSchema[]; values: FieldValues; disabled?: boolean; onejected?: (key: string) => void } = $props();

	let ejecting = $state<string | undefined>();

	/** Ejects at once (it is a live action, not a form edit) and clears the field. */
	async function eject(field: FieldSchema) {
		if (!field.mediaDevice) return;
		ejecting = field.key;
		try {
			await request('ejectMedia', { deviceId: field.mediaDevice });
			values[field.key] = undefined;
			onejected?.(field.key);
		} catch (error) {
			toasts.push({ message: (error as Error).message, icon: 'exclamation-triangle-fill', variant: 'danger' });
		} finally {
			ejecting = undefined;
		}
	}

	function label(field: FieldSchema): string {
		return field.unit ? `${field.label} (${field.unit})` : field.label;
	}

	async function browse(field: FieldSchema) {
		const current = values[field.key];
		const picked = await request('browse', {
			directory: field.type === 'directory',
			title: field.label,
			current: current === undefined ? undefined : String(current),
			filters: field.filters
		});
		if (picked) values[field.key] = picked;
	}
</script>

{#each fields as field (field.key)}
	{#if field.type === 'select'}
		<Input
			type="select"
			name={field.key}
			label={label(field)}
			description={field.description}
			required={field.required}
			disabled={disabled || field.readonly}
			placeholder={field.required ? undefined : '— None —'}
			options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
			bind:value={() => (values[field.key] === undefined ? undefined : String(values[field.key])), (v) => (values[field.key] = v || undefined)}
		/>
	{:else if field.type === 'checkbox'}
		<Input
			type="checkbox"
			name={field.key}
			label={label(field)}
			description={field.description}
			disabled={disabled || field.readonly}
			bind:value={() => Boolean(values[field.key]), (v) => (values[field.key] = v)}
		/>
	{:else if field.type === 'textarea'}
		<Input
			type="textarea"
			name={field.key}
			label={label(field)}
			description={field.description}
			required={field.required}
			readonly={field.readonly}
			disabled={disabled}
			placeholder={field.placeholder}
			bind:value={() => (values[field.key] as string | undefined) ?? '', (v) => (values[field.key] = v || undefined)}
		/>
	{:else if field.type === 'file' || field.type === 'directory'}
		<!-- The browse button is rendered inside the field, on the input's row (see the styles). -->
		<div class="path-field">
			<Input
				type="text"
				name={field.key}
				label={label(field)}
				description={field.description}
				required={field.required}
				readonly={field.readonly}
				disabled={disabled}
				placeholder={field.placeholder ?? 'Path on the host'}
				bind:value={() => (values[field.key] as string | undefined) ?? '', (v) => (values[field.key] = v || undefined)}
			>
				{#snippet children()}
					{#if !field.readonly}
						<Button
							type="button"
							class="browse"
							transparent
							disabled={disabled}
							title="Browse…"
							aria-label="Browse for {field.label}"
							onclick={() => browse(field)}
						>
							<Icon icon="folder2-open" />
						</Button>
						{#if field.mediaDevice && values[field.key]}
							<Button
								type="button"
								class="eject"
								transparent
								disabled={disabled || ejecting === field.key}
								title="Eject"
								aria-label="Eject {field.label}"
								onclick={() => eject(field)}
							>
								<Icon icon="eject-fill" />
							</Button>
						{/if}
					{/if}
				{/snippet}
			</Input>
		</div>
	{:else}
		<Input
			type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
			name={field.key}
			label={label(field)}
			description={field.description}
			required={field.required}
			readonly={field.readonly}
			disabled={disabled}
			placeholder={field.placeholder}
			min={field.min}
			max={field.max}
			bind:value={
				() => (values[field.key] === undefined ? '' : String(values[field.key])),
				(v) => (values[field.key] = v === '' || v === undefined ? undefined : field.type === 'number' ? Number(v) : v)
			}
		/>
	{/if}
{/each}

<style>
	/* Label, description and messages span the row; the input and the browse button share one. */
	.path-field :global(.form-input) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		column-gap: 0.25rem;
		align-items: center;
	}

	.path-field :global(.form-input > *) {
		grid-column: 1 / -1;
	}

	.path-field :global(.form-input > input) {
		grid-column: 1;
	}

	.path-field :global(.form-input > .browse) {
		grid-column: 2;
	}

	.path-field :global(.form-input > .eject) {
		grid-column: 3;
	}
</style>
