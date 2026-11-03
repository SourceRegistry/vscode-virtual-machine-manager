<script lang="ts">
	import { onMount } from 'svelte';
	import { RdpErrorKind, type BootData, type ConsoleStatus, type RdpStartConfig } from '../../../shared/protocol';
	import ConsoleOverlay from '../components/ConsoleOverlay.svelte';
	import { installRelayWebSocket } from '../console/RelayWebSocket';
	import { keyStrokes, sleep, TYPING_DELAY_MS } from '../console/typing';
	import { onMessage, post } from '../rpc/bridge';
	import { Backend, ScreenScale, initIronRdp, vmConnect, type IronError, type UserInteraction } from '../rdp/ironrdp';

	let { boot }: { boot: BootData } = $props();

	let container: HTMLDivElement;
	let element: HTMLElement;
	let status = $state<ConsoleStatus>('connecting');
	let message = $state<string | undefined>();
	// svelte-ignore state_referenced_locally
	let fit = $state(boot.settings?.scaleViewport ?? true);
	let generation = 0;

	/** Progress and errors go to the VM Manager output channel (webview devtools are hard to reach). */
	function trace(message: string, level: 'info' | 'warn' | 'error' = 'info') {
		post({ kind: 'log', level, message });
	}

	let typing = 0;

	/**
	 * Types text as US-layout key presses. IronRDP has no API for raw keys, so this feeds it the
	 * same keyboard events it listens for (it only takes them while the screen has focus).
	 */
	async function typeText(text: string) {
		const run = ++typing;
		const { strokes, skipped } = keyStrokes(text);
		const press = (type: 'keydown' | 'keyup', code: string, key: string, shift: boolean) =>
			window.dispatchEvent(new KeyboardEvent(type, { code, key, shiftKey: shift, bubbles: true, cancelable: true }));
		element.focus();
		for (const stroke of strokes) {
			if (run !== typing || status !== 'open') return;
			if (stroke.shift) press('keydown', 'ShiftLeft', 'Shift', true);
			press('keydown', stroke.code, stroke.key, stroke.shift);
			press('keyup', stroke.code, stroke.key, stroke.shift);
			if (stroke.shift) press('keyup', 'ShiftLeft', 'Shift', false);
			await sleep(TYPING_DELAY_MS);
		}
		if (skipped) {
			post({ kind: 'notify', level: 'warn', message: `${skipped} character${skipped === 1 ? '' : 's'} without a key on a US keyboard were skipped.` });
		}
	}

	/** Re-runs IronRDP's own sizing (it computes a 0×0 viewer when it measures before the canvas has a size). */
	function rescale() {
		try {
			ui?.setScale(fit ? ScreenScale.Fit : ScreenScale.Real);
		} catch {
			// No session.
		}
	}

	let resolveUi: (ui: UserInteraction) => void;
	const uiReady = new Promise<UserInteraction>((resolve) => (resolveUi = resolve));
	let ui: UserInteraction | undefined;

	/** NTSTATUS codes CredSSP reports for rejected accounts (IronRDP surfaces them as general errors). */
	const LOGON_FAILURES = /STATUS_(LOGON_FAILURE|WRONG_PASSWORD|NO_SUCH_USER)|0xc000006[da]|0xc0000064/i;
	const ACCOUNT_PROBLEMS: [RegExp, string][] = [
		[/STATUS_ACCOUNT_RESTRICTION|0xc000006e/i, 'Windows refused this account for network sign-in (account restriction, e.g. a blank password or a Windows Hello-only policy).'],
		[/STATUS_PASSWORD_EXPIRED|0xc0000071/i, 'The password of this account has expired.'],
		[/STATUS_ACCOUNT_DISABLED|0xc0000072/i, 'This account is disabled.'],
		[/STATUS_ACCOUNT_LOCKED_OUT|0xc0000234/i, 'This account is locked out.']
	];

	function describe(error: unknown): { kind?: number; text: string } {
		const iron = error as Partial<IronError> | undefined;
		let kind = typeof iron?.kind === 'function' ? iron.kind() : undefined;
		const detail = typeof iron?.backtrace === 'function' ? iron.backtrace().split('\n')[0] : error instanceof Error ? error.message : String(error);
		if (LOGON_FAILURES.test(detail)) kind = RdpErrorKind.LogonFailure;
		const problem = ACCOUNT_PROBLEMS.find(([pattern]) => pattern.test(detail));
		if (problem) return { kind, text: problem[1] };
		switch (kind) {
			case RdpErrorKind.WrongPassword:
			case RdpErrorKind.LogonFailure:
				return { kind, text: 'The user name or password was rejected.' };
			case RdpErrorKind.AccessDenied:
				return { kind, text: 'Access denied. The account must be allowed to manage Hyper-V (member of "Hyper-V Administrators").' };
			default:
				return { kind, text: detail || 'The connection failed.' };
		}
	}

	async function start(config: RdpStartConfig) {
		const current = ++generation;
		status = 'connecting';
		message = undefined;
		try {
			if (!boot.rdp) throw new Error('The RDP client is not available.');
			await initIronRdp(boot.rdp.wasmUrl);
			trace('RDP client loaded');
			const interaction = await uiReady;
			if (current !== generation) return;
			try {
				interaction.shutdown();
			} catch {
				// No previous session.
			}
			const rect = container.getBoundingClientRect();
			let builder = interaction
				.configBuilder()
				.withUsername(config.username)
				.withPassword(config.password)
				.withServerDomain(config.domain)
				.withDestination(config.destination)
				// Never dialled: RelayWebSocket tunnels it to the extension host's gateway.
				.withProxyAddress('wss://vm-manager.relay.invalid/rdcleanpath')
				.withAuthToken(config.authToken)
				.withDesktopSize({ width: Math.max(640, Math.round(rect.width)), height: Math.max(480, Math.round(rect.height)) });
			if (config.vmConnect) {
				builder = builder.withExtension(vmConnect(config.vmConnect.vmId, config.vmConnect.mode, config.singleSignOn));
			}
			trace(`RDP client connecting (${config.singleSignOn ? 'single sign-on' : 'password'}, ${config.vmConnect?.mode ?? 'rdp'} session)`);
			const session = await interaction.connect(builder.build());
			if (current !== generation) return;
			const size = session.initialDesktopSize;
			trace(`RDP session established, desktop ${size?.width}x${size?.height}`);
			status = 'open';
			interaction.setVisibility(true);
			interaction.setScale(fit ? ScreenScale.Fit : ScreenScale.Real);
			element.focus();
			for (const delay of [300, 1000]) setTimeout(() => current === generation && rescale(), delay);
			const termination = await session.run();
			if (current !== generation) return;
			trace(`RDP session ended: ${termination.reason() || 'no reason given'}`);
			status = 'closed';
			message = termination.reason() || 'The console session ended.';
			post({ kind: 'rdp.ended' });
		} catch (error) {
			if (current !== generation) return;
			const { kind, text } = describe(error);
			const iron = error as Partial<IronError>;
			trace(`RDP client error (kind ${kind ?? '?'}): ${typeof iron?.backtrace === 'function' ? iron.backtrace() : String(error)}`, 'error');
			status = 'error';
			// The host usually knows better why the gateway failed (VM off, service unreachable…).
			message = message ?? text;
			post({ kind: 'rdp.ended', errorKind: kind, message: text });
		}
	}

	onMount(() => {
		const restoreWebSocket = installRelayWebSocket();
		// IronRDP's WebAssembly logs through console.warn/error; forward them.
		const original = { warn: console.warn, error: console.error };
		console.warn = (...args: unknown[]) => {
			original.warn(...args);
			trace(args.map(String).join(' '), 'warn');
		};
		console.error = (...args: unknown[]) => {
			original.error(...args);
			trace(args.map(String).join(' '), 'error');
		};
		const onError = (event: ErrorEvent) => trace(`Uncaught: ${event.message}`, 'error');
		const onRejection = (event: PromiseRejectionEvent) => trace(`Unhandled rejection: ${String(event.reason)}`, 'error');
		window.addEventListener('error', onError);
		window.addEventListener('unhandledrejection', onRejection);
		const onReady = (event: Event) => {
			ui = (event as CustomEvent<{ irgUserInteraction: UserInteraction }>).detail.irgUserInteraction;
			resolveUi(ui);
		};
		element.addEventListener('ready', onReady);
		(element as HTMLElement & { module?: unknown }).module = Backend;
		// The webview can resize without a window `resize` event reaching IronRDP (panel / sash moves).
		let resizeTimer: ReturnType<typeof setTimeout> | undefined;
		const observer =
			typeof ResizeObserver === 'undefined'
				? undefined
				: new ResizeObserver(() => {
						clearTimeout(resizeTimer);
						resizeTimer = setTimeout(() => status === 'open' && rescale(), 100);
					});
		observer?.observe(container);

		const unsubscribe = onMessage((msg) => {
			switch (msg.kind) {
				case 'rdp.start':
					void start(msg.config);
					break;
				case 'console.status':
					// `open` / `closed` describe the relayed socket; the session state comes from IronRDP.
					if (msg.status === 'connecting') {
						generation++;
						status = 'connecting';
						message = undefined;
					} else if (msg.status === 'error') {
						message = msg.message;
						if (status !== 'open') status = 'error';
					}
					break;
				case 'console.type':
					if (status === 'open') void typeText(msg.text);
					break;
				case 'console.command':
					if (msg.command === 'ctrlAltDel') ui?.ctrlAltDel();
					if (msg.command === 'toggleScaling') {
						fit = !fit;
						ui?.setScale(fit ? ScreenScale.Fit : ScreenScale.Real);
					}
					break;
			}
		});
		post({ kind: 'ready' });
		return () => {
			unsubscribe();
			observer?.disconnect();
			clearTimeout(resizeTimer);
			console.warn = original.warn;
			console.error = original.error;
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onRejection);
			element.removeEventListener('ready', onReady);
			try {
				ui?.shutdown();
			} catch {
				// Already closed.
			}
			restoreWebSocket();
		};
	});
</script>

<div class="console" class:scrollable={!fit} bind:this={container}>
	<iron-remote-desktop
		bind:this={element}
		class="screen"
		scale={fit ? 'fit' : 'real'}
		verbose="false"
		flexcenter="true"
		aria-label="Graphical console of {boot.vmName}"
	></iron-remote-desktop>
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
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
