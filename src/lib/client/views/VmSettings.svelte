<script lang="ts">
	import { onMount } from 'svelte';
	import Page from '#lib/client-lib/components/layout/Page.svelte';
	import Section from '#lib/client-lib/components/layout/Section.svelte';
	import Flexbox from '#lib/client-lib/components/layout/Flexbox.svelte';
	import Card from '#lib/client-lib/components/display/Card.svelte';
	import Form from '#lib/client-lib/components/form/Form.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import Loader from '#lib/client-lib/components/feedback/Loader.svelte';
	import Status from '#lib/client-lib/components/feedback/Status.svelte';
	import { toasts } from '#lib/client-lib/components/toast/index.js';
	import { coerceValues, type FieldSchema, type FieldValues, type VmInfo } from '@vmm/sdk';
	import type { BootData } from '../../../shared/protocol';
	import SchemaForm from '../components/SchemaForm.svelte';
	import { setFormActionHandler } from '../shims/app-forms';
	import { onMessage, request } from '../rpc/bridge';
	import { vmStates } from '../vmState';

	let { boot }: { boot: BootData } = $props();

	let schema = $state<FieldSchema[]>([]);
	let values = $state<FieldValues>({});
	let saved = $state<string>('{}');
	let vm = $state<VmInfo | undefined>();
	let loading = $state(true);
	let loadError = $state<string | undefined>();
	let saving = $state(false);

	const editable = $derived(schema.filter((f) => !f.readonly));
	const dirty = $derived(JSON.stringify(coerceValues(editable, values)) !== saved);
	const groups = $derived.by(() => {
		const map = new Map<string, FieldSchema[]>();
		for (const field of schema) {
			const group = field.group ?? 'General';
			map.set(group, [...(map.get(group) ?? []), field]);
		}
		return [...map.entries()];
	});

	async function load() {
		loading = true;
		loadError = undefined;
		try {
			const config = await request('getConfig');
			schema = config.schema;
			values = { ...config.values };
			saved = JSON.stringify(coerceValues(config.schema.filter((f) => !f.readonly), config.values));
			vm = config.vm;
		} catch (error) {
			loadError = (error as Error).message;
		} finally {
			loading = false;
		}
	}

	/** An eject already happened on the host, so it is no longer an unsaved change. */
	function markEjected(key: string) {
		const baseline = JSON.parse(saved) as FieldValues;
		delete baseline[key];
		saved = JSON.stringify(baseline);
	}

	function revert() {
		values = { ...JSON.parse(saved), ...Object.fromEntries(schema.filter((f) => f.readonly).map((f) => [f.key, values[f.key]])) };
	}

	onMount(() => {
		// client-lib <Form> submits through the `$app/forms` shim; route it to the host.
		setFormActionHandler(async () => {
			saving = true;
			try {
				const result = await request('save', { values: $state.snapshot(values) });
				saved = JSON.stringify(coerceValues(editable, values));
				return { type: 'success', status: 200, data: result };
			} catch (error) {
				return { type: 'failure', status: 400, data: { message: (error as Error).message } };
			} finally {
				saving = false;
			}
		});
		void load();
		const unsubscribe = onMessage((message) => {
			if (message.kind === 'event' && message.name === 'vm') vm = message.payload;
		});
		return () => {
			unsubscribe();
			setFormActionHandler(undefined);
		};
	});
</script>

<Page title={vm?.name ?? boot.vmName ?? 'Virtual machine'} description="Virtual machine settings" sticky_header={false}>
	{#snippet suffix()}
		{#if vm}<Status value={vm.state} states={vmStates} />{/if}
	{/snippet}

	{#if loading}
		<Flexbox justify="center" style="padding: 3rem 0;"><Loader /></Flexbox>
	{:else if loadError}
		<Section>
			<Card variant="danger" title="Could not load settings" description={loadError}>
				<Button onclick={load}><Icon icon="arrow-clockwise" margin="right" />Retry</Button>
			</Card>
		</Section>
	{:else}
		{#if vm && vm.state !== 'stopped'}
			<Section>
				<Card
					variant="info"
					title="The virtual machine is {vmStates[vm.state].title?.toLowerCase()}"
					description="Some settings, such as processors or memory, can only be changed while it is off. Changes that need a restart apply on the next start."
				/>
			</Section>
		{/if}
		<Form action="?/save" reset={false} toast={false} onsuccess={() => toasts.push({ message: 'Settings saved', icon: 'check-circle-fill', variant: 'success' })}>
			{#each groups as [group, fields] (group)}
				<Section title={group}>
					<Card>
						<SchemaForm {fields} bind:values disabled={saving} onejected={markEjected} />
					</Card>
				</Section>
			{/each}
			<Section>
				<Flexbox justify="flex-end" gap="0.5rem">
					<Button type="button" transparent disabled={!dirty || saving} onclick={revert}>Revert</Button>
					<Button type="submit" variant="primary" disabled={!dirty} loading={saving}>
						<Icon icon="floppy" margin="right" />Save
					</Button>
				</Flexbox>
			</Section>
		</Form>
	{/if}
</Page>
