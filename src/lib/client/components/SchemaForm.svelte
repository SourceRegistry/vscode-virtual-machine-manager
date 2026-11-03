<script lang="ts">
	import Input from '#lib/client-lib/components/form/Input.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import Flexbox from '#lib/client-lib/components/layout/Flexbox.svelte';
	import type { FieldSchema, FieldValues } from '@vmm/sdk';
	import { request } from '../rpc/bridge';

	/**
	 * Renders provider field schemas with client-lib inputs. The same schemas drive the native
	 * multi-step input on the host, so providers describe their fields once.
	 */
	let {
		fields,
		values = $bindable(),
		disabled = false
	}: { fields: FieldSchema[]; values: FieldValues; disabled?: boolean } = $props();

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
		<Flexbox align="flex-end" gap="0.5rem">
			<div style="flex: 1; min-width: 0;">
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
				/>
			</div>
			{#if !field.readonly}
				<Button
					type="button"
					transparent
					disabled={disabled}
					title="Browse…"
					aria-label="Browse for {field.label}"
					onclick={() => browse(field)}
					style="margin-bottom: 1rem;"
				>
					<Icon icon="folder2-open" />
				</Button>
			{/if}
		</Flexbox>
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
