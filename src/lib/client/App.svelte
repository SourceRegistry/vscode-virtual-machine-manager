<script lang="ts">
	import Toaster from '#lib/client-lib/components/toast/Toaster.svelte';
	import type { BootData } from '../../shared/protocol';
	import Overview from './views/Overview.svelte';
	import VmSettings from './views/VmSettings.svelte';
	import ConsoleVnc from './views/ConsoleVnc.svelte';
	import ConsoleSerial from './views/ConsoleSerial.svelte';
	import ConsolePreview from './views/ConsolePreview.svelte';
	import ConsoleRdp from './views/ConsoleRdp.svelte';

	let { boot }: { boot: BootData } = $props();
</script>

{#if boot.view === 'overview'}
	<Overview />
{:else if boot.view === 'vmSettings'}
	<VmSettings {boot} />
{:else if boot.view === 'console.vnc'}
	<ConsoleVnc {boot} />
{:else if boot.view === 'console.serial'}
	<ConsoleSerial {boot} />
{:else if boot.view === 'console.preview'}
	<ConsolePreview {boot} />
{:else if boot.view === 'console.rdp'}
	<ConsoleRdp {boot} />
{/if}

<Toaster />
