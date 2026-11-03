<script lang="ts">
	import { onMount } from 'svelte';
	import { Terminal, type ITheme } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import type { BootData, ConsoleStatus } from '../../../shared/protocol';
	import ConsoleOverlay from '../components/ConsoleOverlay.svelte';
	import { onMessage, post } from '../rpc/bridge';
	import { onThemeChange, themeColor } from '../theme-sync';

	let { boot }: { boot: BootData } = $props();

	let host: HTMLDivElement;
	let status = $state<ConsoleStatus>('connecting');
	let message = $state<string | undefined>();

	const ANSI = [
		'Black',
		'Red',
		'Green',
		'Yellow',
		'Blue',
		'Magenta',
		'Cyan',
		'White',
		'BrightBlack',
		'BrightRed',
		'BrightGreen',
		'BrightYellow',
		'BrightBlue',
		'BrightMagenta',
		'BrightCyan',
		'BrightWhite'
	] as const;

	/** Builds the xterm theme from the user's VS Code terminal colours. */
	function terminalTheme(): ITheme {
		const background = themeColor('terminal.background') || themeColor('panel.background') || themeColor('editor.background');
		const theme: ITheme = {
			background,
			foreground: themeColor('terminal.foreground', themeColor('editor.foreground')),
			cursor: themeColor('terminalCursor.foreground', themeColor('terminal.foreground')),
			cursorAccent: themeColor('terminalCursor.background', background),
			selectionBackground: themeColor('terminal.selectionBackground', themeColor('editor.selectionBackground'))
		};
		for (const name of ANSI) {
			const key = (name.charAt(0).toLowerCase() + name.slice(1)) as keyof ITheme;
			const value = themeColor(`terminal.ansi${name}`);
			if (value) (theme as Record<string, string>)[key] = value;
		}
		return theme;
	}

	function fontFamily(): string {
		return themeColor('editor.font.family') || getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
	}

	function fontSize(): number {
		const size = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size'), 10);
		return Number.isFinite(size) ? size : 14;
	}

	onMount(() => {
		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: fontFamily(),
			fontSize: fontSize(),
			theme: terminalTheme(),
			scrollback: 5000,
			allowProposedApi: false
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host);
		fit.fit();

		const encoder = new TextEncoder();
		terminal.onData((data) => post({ kind: 'console.input', data: encoder.encode(data) }));
		terminal.onBinary((data) => post({ kind: 'console.input', data: Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff) }));

		const resize = new ResizeObserver(() => fit.fit());
		resize.observe(host);
		const unsubscribeTheme = onThemeChange(() => {
			terminal.options.theme = terminalTheme();
			terminal.options.fontFamily = fontFamily();
			terminal.options.fontSize = fontSize();
		});

		const unsubscribe = onMessage((msg) => {
			switch (msg.kind) {
				case 'console.status':
					status = msg.status;
					message = msg.message;
					if (msg.status === 'open') {
						terminal.focus();
						// Nudge the guest to print a fresh prompt.
						post({ kind: 'console.input', data: encoder.encode('\r') });
					}
					break;
				case 'console.data':
					terminal.write(msg.data);
					break;
			}
		});
		post({ kind: 'ready' });

		return () => {
			unsubscribe();
			unsubscribeTheme();
			resize.disconnect();
			terminal.dispose();
		};
	});
</script>

<div class="console">
	<div class="terminal" bind:this={host} aria-label="Serial console of {boot.vmName}"></div>
	<ConsoleOverlay {status} {message} />
</div>

<style>
	.console {
		position: fixed;
		inset: 0;
		background: var(--vscode-terminal-background, var(--vscode-panel-background, var(--vscode-editor-background)));
	}

	.terminal {
		position: absolute;
		inset: 0.5rem 0 0 0.75rem;
	}
</style>
