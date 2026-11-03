<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '#lib/client-lib/components/actions/Button.svelte';
	import Icon from '#lib/client-lib/components/icons/Icon.svelte';
	import type { PreviewFrame } from '@vmm/sdk';
	import type { BootData, ConsoleStatus } from '../../../shared/protocol';
	import ConsoleOverlay from '../components/ConsoleOverlay.svelte';
	import { onMessage, post, request } from '../rpc/bridge';

	let { boot }: { boot: BootData } = $props();

	let canvas: HTMLCanvasElement;
	let status = $state<ConsoleStatus>('connecting');
	let message = $state<string | undefined>();
	// svelte-ignore state_referenced_locally
	let scale = $state(boot.settings?.scaleViewport ?? true);
	let resolution = $state('');

	function toRgba(frame: PreviewFrame): Uint8ClampedArray<ArrayBuffer> {
		const pixels = frame.width * frame.height;
		const rgba = new Uint8ClampedArray(new ArrayBuffer(pixels * 4));
		if (frame.format === 'rgba') {
			rgba.set(frame.data.subarray(0, pixels * 4));
			return rgba;
		}
		// RGB565, little endian (Hyper-V thumbnails).
		for (let i = 0; i < pixels; i++) {
			const value = frame.data[i * 2] | (frame.data[i * 2 + 1] << 8);
			const r = (value >> 11) & 0x1f;
			const g = (value >> 5) & 0x3f;
			const b = value & 0x1f;
			rgba[i * 4] = (r << 3) | (r >> 2);
			rgba[i * 4 + 1] = (g << 2) | (g >> 4);
			rgba[i * 4 + 2] = (b << 3) | (b >> 2);
			rgba[i * 4 + 3] = 255;
		}
		return rgba;
	}

	function draw(frame: PreviewFrame) {
		if (canvas.width !== frame.width || canvas.height !== frame.height) {
			canvas.width = frame.width;
			canvas.height = frame.height;
			resolution = `${frame.width} × ${frame.height}`;
		}
		canvas.getContext('2d')?.putImageData(new ImageData(toRgba(frame), frame.width, frame.height), 0, 0);
	}

	onMount(() => {
		const unsubscribe = onMessage((msg) => {
			switch (msg.kind) {
				case 'console.status':
					status = msg.status;
					message = msg.message;
					break;
				case 'preview.frame':
					draw(msg.frame);
					break;
				case 'console.command':
					if (msg.command === 'toggleScaling') scale = !scale;
					break;
			}
		});
		post({ kind: 'ready' });
		return unsubscribe;
	});
</script>

<div class="console">
	<div class="stage" class:scale>
		<canvas bind:this={canvas} aria-label="Screen preview of {boot.vmName}"></canvas>
	</div>
	<div class="bar">
		<span class="hint">
			<Icon icon="eye" margin="right" />Live preview (read-only){resolution ? ` · ${resolution}` : ''}. Use the native viewer for keyboard
			and mouse input.
		</span>
		<Button size="sm" onclick={() => request('openExternal')}>
			<Icon icon="box-arrow-up-right" margin="right" />Open native viewer
		</Button>
	</div>
	<ConsoleOverlay {status} {message} />
</div>

<style>
	.console {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--vscode-editor-background);
	}

	.stage {
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.stage.scale canvas {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}

	canvas {
		image-rendering: auto;
		box-shadow: 0 0 0 1px var(--vscode-widget-border, transparent);
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0.75rem;
		border-top: 1px solid var(--vscode-panel-border, transparent);
		background: var(--vscode-editorWidget-background);
	}

	.hint {
		color: var(--vscode-descriptionForeground);
	}
</style>
