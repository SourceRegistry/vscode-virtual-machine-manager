/**
 * Context-value encoding shared by the tree (`TreeItem.contextValue`, matched as `viewItem`) and the
 * overview webview (`data-vscode-context` key `vmmItem`). The `when` regexes in package.json match
 * these strings, so both surfaces show the same native context menu for the same state.
 *
 *   cluster;status=<status>;[signout;][rdp;]     rdp: the provider opens RDP consoles (remembered credentials)
 *   node;status=<status>;[create;][adopt;][import;]
 *   vm;state=<state>;flag;flag;     flags: power actions, busy, favorite, graphical, serial, terminal (serial without a display), external, media, ejectable, disks, snapshots, guestexec, guestfiles, clone, details, edit, delete, istemplate (is a template), totemplate (can become one)
 *
 * While a power operation runs, `state` is the transitional state and only the actions allowed
 * during it are listed (see operations.ts), plus `busy`.
 */
import type { Capabilities, PowerAction, VmInfo } from '@vmm/sdk';
import { allowedDuring } from './operations';
import type { ClusterStatus } from './protocol';

/**
 * What at least one connected cluster can do, as `vmm.can.<feature>` context keys. The command palette shows a VM
 * command only when some connected provider supports it (the context menus check the VM's own flags instead).
 */
export const FEATURES = ['start', 'shutdown', 'reboot', 'stop', 'graphical', 'serial', 'external', 'details', 'media', 'disks', 'snapshots', 'guestexec', 'guestfiles', 'clone', 'templates', 'edit', 'delete', 'adopt', 'forwards'] as const;
export type Feature = (typeof FEATURES)[number];

export function featureFlags(capabilities: Capabilities[]): Record<Feature, boolean> {
	const any = (test: (caps: Capabilities) => boolean | undefined) => capabilities.some((caps) => !!test(caps));
	return {
		start: any((c) => c.power.includes('start')),
		shutdown: any((c) => c.power.includes('shutdown')),
		reboot: any((c) => c.power.includes('reboot')),
		stop: any((c) => c.power.includes('stop')),
		graphical: any((c) => c.consoles.includes('vnc') || c.consoles.includes('rdp') || c.preview),
		serial: any((c) => c.consoles.includes('serial')),
		external: any((c) => c.external),
		details: any((c) => c.details || c.stats),
		media: any((c) => c.media),
		disks: any((c) => !!c.diskOperations?.length),
		snapshots: any((c) => c.snapshots),
		guestexec: any((c) => c.guestExec),
		guestfiles: any((c) => c.guestFiles),
		clone: any((c) => c.clone),
		templates: any((c) => c.templates),
		edit: any((c) => c.edit),
		delete: any((c) => c.delete),
		adopt: any((c) => c.adopt),
		forwards: any((c) => c.forwards)
	};
}

export function clusterContextValue(status: ClusterStatus, caps?: Capabilities): string {
	return `cluster;status=${status};${status === 'connected' && caps?.signOut ? 'signout;' : ''}${caps?.consoles.includes('rdp') ? 'rdp;' : ''}`;
}

export function nodeContextValue(status: string, caps: Capabilities | undefined): string {
	return `node;status=${status};${caps?.create ? 'create;' : ''}${caps?.adopt ? 'adopt;' : ''}${caps?.importFolder ? 'import;' : ''}`;
}

export function vmContextValue(vm: VmInfo & { operation?: PowerAction; favorite?: boolean }, caps: Capabilities | undefined): string {
	const flags: string[] = [];
	// Marks are the core's own: offered whatever the provider can do.
	if (vm.favorite) flags.push('favorite');
	if (caps) {
		const running = vm.operation;
		// An attached VM without a control channel cannot be asked to do anything but die.
		const powers = vm.controllable === false ? caps.power.filter((action) => action === 'stop') : caps.power;
		// A template is never started: it is only copied.
		const allowed = vm.template ? [] : powers;
		flags.push(...(running ? allowed.filter((action) => allowedDuring(running, action)) : allowed));
		if (running) flags.push('busy');
		const consoles = vm.consoles ?? caps.consoles;
		const graphical = consoles.includes('vnc') || consoles.includes('rdp') || caps.preview;
		if (graphical) flags.push('graphical');
		if (consoles.includes('serial')) {
			flags.push('serial');
			// The terminal is the quick action only when there is no display; a display always wins.
			if (!graphical) flags.push('terminal');
		}
		if (caps.external) flags.push('external');
		if (caps.details || caps.stats) flags.push('details');
		if (caps.media) {
			flags.push('media');
			if (vm.mediaInserted) flags.push('ejectable');
		}
		// An attached VM's disks belong to whoever started it.
		if (caps.diskOperations?.length && vm.origin !== 'adopted') flags.push('disks');
		if (caps.snapshots) flags.push('snapshots');
		if (caps.guestExec) flags.push('guestexec');
		if (caps.guestFiles) flags.push('guestfiles');
		if (vm.template) flags.push('istemplate');
		else if (caps.templates && vm.origin !== 'adopted') flags.push('totemplate');
		if (caps.clone) flags.push('clone');
		if (caps.edit) flags.push('edit');
		// An attached VM is not ours to delete: it can only be let go.
		if (vm.origin === 'adopted') flags.push('detach');
		else if (caps.delete) flags.push('delete');
	}
	return `vm;state=${vm.state};${flags.map((f) => `${f};`).join('')}`;
}
