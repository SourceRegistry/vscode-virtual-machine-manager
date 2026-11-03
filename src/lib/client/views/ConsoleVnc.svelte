<script lang="ts">
	import { onMount } from 'svelte';
	import RFB from '@novnc/novnc';
	import type { BootData, ConsoleStatus } from '../../../shared/protocol';
	import ConsoleOverlay from '../components/ConsoleOverlay.svelte';
	import { PostMessageChannel } from '../console/PostMessageChannel';
	import { onMessage, post } from '../rpc/bridge';

	let { boot }: { boot: BootData } = $props();

	let screen: HTMLDivElement;
	let status = $state<ConsoleStatus>('connecting');
	let message = $state<string | undefined>();
	// svelte-ignore state_referenced_locally
	let scale = $state(boot.settings?.scaleViewport ?? true);
	let rfb: RFB | undefined;
	let channel: PostMessageChannel | undefined;

	function createSession() {
		rfb?.disconnect();
		channel = new PostMessageChannel();
		rfb = new RFB(screen, channel, { shared: true });
		rfb.scaleViewport = scale;
		rfb.resizeSession = false;
		rfb.focusOnClick = true;
		rfb.background = 'var(--vscode-editor-background)';
		const current = rfb;
		rfb.addEventListener('connect', () => {
			if (rfb === current) current.focus();
		});
		rfb.addEventListener('disconnect', (event) => {
			if (rfb !== current) return;
			const clean = (event as CustomEvent<{ clean: boolean }>).detail?.clean;
			if (status === 'open') {
				status = clean ? 'closed' : 'error';
				message = clean ? 'The VNC session ended.' : 'The VNC connection was lost.';
			}
		});
		rfb.addEventListener('securityfailure', (event) => {
			if (rfb !== current) return;
			status = 'error';
			message = `Authentication failed: ${(event as CustomEvent<{ reason?: string }>).detail?.reason ?? 'unknown reason'}`;
		});
	}

	onMount(() => {
		const unsubscribe = onMessage((msg) => {
			switch (msg.kind) {
				case 'console.status':
					status = msg.status;
					message = msg.message;
					if (msg.status === 'connecting') createSession();
					else if (msg.status === 'open') channel?.markOpen();
					else channel?.markClosed(msg.message);
					break;
				case 'console.data':
					channel?.receive(msg.data);
					break;
				case 'console.command':
					if (msg.command === 'ctrlAltDel') rfb?.sendCtrlAltDel();
					if (msg.command === 'toggleScaling') {
						scale = !scale;
						if (rfb) rfb.scaleViewport = scale;
					}
					break;
			}
		});
		post({ kind: 'ready' });
		return () => {
			unsubscribe();
			rfb?.disconnect();
		};
	});
</script>

<div class="console" class:scrollable={!scale}>
	<div class="screen" bind:this={screen} aria-label="Graphical console of {boot.vmName}"></div>
	<ConsoleOverlay {status} {message} />
</div>

<style>
	.console {
		position: fixed;
		inset: 0;
		background: var(--vscode-editor-background);
		overflow: hidden;
	}

	.console.scrollable {
		overflow: auto;
	}

	.screen {
		width: 100%;
		height: 100%;
	}
</style>
