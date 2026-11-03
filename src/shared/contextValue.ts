/**
 * Context-value encoding shared by the tree (`TreeItem.contextValue`, matched as `viewItem`) and the
 * overview webview (`data-vscode-context` key `vmmItem`). The `when` regexes in package.json match
 * these strings, so both surfaces show the same native context menu for the same state.
 *
 *   cluster;status=<status>;
 *   node;status=<status>;[create;]
 *   vm;state=<state>;flag;flag;     flags: power actions, graphical, serial, external, edit, delete
 */
import type { Capabilities, VmInfo } from '@vmm/sdk';
import type { ClusterStatus } from './protocol';

export function clusterContextValue(status: ClusterStatus): string {
	return `cluster;status=${status};`;
}

export function nodeContextValue(status: string, caps: Capabilities | undefined): string {
	return `node;status=${status};${caps?.create ? 'create;' : ''}`;
}

export function vmContextValue(vm: VmInfo, caps: Capabilities | undefined): string {
	const flags: string[] = [];
	if (caps) {
		flags.push(...caps.power);
		const consoles = vm.consoles ?? caps.consoles;
		if (consoles.includes('vnc') || caps.preview) flags.push('graphical');
		if (consoles.includes('serial')) flags.push('serial');
		if (caps.external) flags.push('external');
		if (caps.edit) flags.push('edit');
		if (caps.delete) flags.push('delete');
	}
	return `vm;state=${vm.state};${flags.map((f) => `${f};`).join('')}`;
}
