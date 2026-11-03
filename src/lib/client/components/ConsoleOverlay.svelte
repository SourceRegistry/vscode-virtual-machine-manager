<script lang="ts">
	import Card from '#lib/client-lib/components/display/Card.svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import Loader from '#lib/client-lib/components/feedback/Loader.svelte';
	import Flexbox from '#lib/client-lib/components/layout/Flexbox.svelte';
	import type { ConsoleStatus } from '../../../shared/protocol';
	import { request } from '../rpc/bridge';

	let { status, message }: { status: ConsoleStatus; message?: string } = $props();
	let busy = $state(false);

	async function reconnect() {
		busy = true;
		try {
			await request('reconnect');
		} finally {
			busy = false;
		}
	}

	async function startAndReconnect() {
		busy = true;
		try {
			await request('power', { action: 'start' });
			// Give the hypervisor a moment to open its console endpoints.
			await new Promise((r) => setTimeout(r, 1500));
			await request('reconnect');
		} catch {
			// Errors are reported through the console status.
		} finally {
			busy = false;
		}
	}

	const notRunning = $derived(!!message && /not running|is off|stopped/i.test(message));
</script>

{#if status !== 'open'}
	<div class="overlay" role="status" aria-live="polite">
		{#if status === 'connecting'}
			<Flexbox direction="column" align="center" gap="1rem">
				<Loader />
				<span class="hint">Connecting…</span>
			</Flexbox>
		{:else}
			<div class="card-wrapper">
				<Card
					variant={status === 'error' ? 'danger' : 'default'}
					title={status === 'error' ? 'Console unavailable' : 'Disconnected'}
					description={message ?? 'The console connection was closed.'}
				>
					<Flexbox justify="flex-end" gap="0.5rem">
						{#if notRunning}
							<Button transparent loading={busy} onclick={startAndReconnect}>
								<Icon icon="play-fill" margin="right" />Start VM
							</Button>
						{/if}
						<Button variant="primary" loading={busy} onclick={reconnect}>
							<Icon icon="arrow-clockwise" margin="right" />Reconnect
						</Button>
					</Flexbox>
				</Card>
			</div>
		{/if}
	</div>
{/if}

<style>
	.overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
		z-index: 10;
	}

	.card-wrapper {
		width: min(28rem, calc(100% - 2rem));
	}

	.hint {
		color: var(--vscode-descriptionForeground);
	}
</style>
