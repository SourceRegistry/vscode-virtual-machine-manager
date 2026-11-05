/**
 * Context-value encoding shared by the tree (`TreeItem.contextValue`, matched as `viewItem`) and the
 * overview webview (`data-vscode-context` key `vmmItem`). The `when` regexes in package.json match
 * these strings, so both surfaces show the same native context menu for the same state.
 *
 *   cluster;status=<status>;
 *   node;status=<status>;[create;]
 *   vm;state=<state>;flag;flag;     flags: power actions, busy, graphical, serial, external, media, ejectable, details, edit, delete
 *
 * While a power operation runs, `state` is the transitional state and only the actions allowed
 * during it are listed (see operations.ts), plus `busy`.
 */
import type { Capabilities, PowerAction, VmInfo } from '@vmm/sdk';
import { allowedDuring } from './operations';
import type { ClusterStatus } from './protocol';

export function clusterContextValue(status: ClusterStatus): string {
	return `cluster;status=${status};`;
}

export function nodeContextValue(status: string, caps: Capabilities | undefined): string {
	return `node;status=${status};${caps?.create ? 'create;' : ''}`;
}

export function vmContextValue(vm: VmInfo & { operation?: PowerAction }, caps: Capabilities | undefined): string {
	const flags: string[] = [];
	if (caps) {
		const running = vm.operation;
		flags.push(...(running ? caps.power.filter((action) => allowedDuring(running, action)) : caps.power));
		if (running) flags.push('busy');
		const consoles = vm.consoles ?? caps.consoles;
		if (consoles.includes('vnc') || consoles.includes('rdp') || caps.preview) flags.push('graphical');
		if (consoles.includes('serial')) flags.push('serial');
		if (caps.external) flags.push('external');
		if (caps.details || caps.stats) flags.push('details');
		if (caps.media) {
			flags.push('media');
			if (vm.mediaInserted) flags.push('ejectable');
		}
		if (caps.edit) flags.push('edit');
		if (caps.delete) flags.push('delete');
	}
	return `vm;state=${vm.state};${flags.map((f) => `${f};`).join('')}`;
}
