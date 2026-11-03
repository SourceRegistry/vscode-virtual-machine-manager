/**
 * Thin wrapper over the vendored IronRDP WebAssembly client (vendor/ironrdp, MIT OR Apache-2.0).
 * Equivalent to IronRDP's `iron-remote-desktop-rdp` package, limited to what the console uses.
 */
import wasmInit, {
	ClipboardData,
	DesktopSize,
	DeviceEvent,
	Extension,
	InputTransaction,
	SessionBuilder,
	setup
} from '../../../../vendor/ironrdp/pkg/ironrdp_web.js';
import type { RemoteDesktopModule } from '../../../../vendor/ironrdp/iron-remote-desktop/interfaces/RemoteDesktopModule';
import 'virtual:ironrdp-element';

export type { UserInteraction } from '../../../../vendor/ironrdp/iron-remote-desktop/interfaces/UserInteraction';
export type { IronError } from '../../../../vendor/ironrdp/iron-remote-desktop/interfaces/Error';
export { ScreenScale } from '../../../../vendor/ironrdp/iron-remote-desktop/enums/ScreenScale';

let initialized: Promise<void> | undefined;

/** Loads the WebAssembly module once per page. */
export function initIronRdp(wasmUrl: string, logLevel = 'warn'): Promise<void> {
	initialized ??= (async () => {
		await wasmInit({ module_or_path: wasmUrl });
		setup(logLevel);
	})();
	return initialized;
}

export const Backend = {
	DesktopSize,
	InputTransaction,
	SessionBuilder,
	ClipboardData,
	DeviceEvent
} as unknown as RemoteDesktopModule;

/**
 * Hyper-V VMConnect routing (pre-connection blob payload sent by the gateway). With
 * `gatewayCredssp` the gateway signs in with the Windows logon and the client skips CredSSP
 * (vendored IronRDP patch, scripts/ironrdp-patches); the marker never reaches Hyper-V.
 */
export function vmConnect(vmId: string, mode: 'basic' | 'enhanced', gatewayCredssp = false): Extension {
	const payload = mode === 'enhanced' ? `${vmId};EnhancedMode=1` : vmId;
	return new Extension('vmconnect', gatewayCredssp ? `${payload};VmmProxyCredssp=1` : payload);
}

export function displayControl(enable: boolean): Extension {
	return new Extension('display_control', enable);
}
