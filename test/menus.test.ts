/**
 * Evaluates the `viewItem =~ /…/` / `vmmItem =~ /…/` parts of the contributed context menus against the
 * real context-value encoding, so a broken regex (e.g. a JSON "\b" that became a backspace) fails here
 * instead of silently hiding menu items.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Capabilities, VmInfo, VmState } from '@vmm/sdk';
import { clusterContextValue, nodeContextValue, vmContextValue } from '../src/shared/contextValue';

interface MenuItem {
	command: string;
	when: string;
	group: string;
}

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
const menus = pkg.contributes.menus as Record<string, MenuItem[]>;

const caps: Capabilities = {
	create: true,
	edit: true,
	delete: true,
	power: ['start', 'shutdown', 'reboot', 'stop'],
	consoles: ['serial'],
	preview: true,
	external: true
};

function regexOf(when: string): RegExp {
	const match = /(?:viewItem|vmmItem) =~ \/(.*)\//.exec(when);
	if (!match) throw new Error(`No item regex in: ${when}`);
	return new RegExp(match[1]);
}

function commandsFor(menu: string, contextValue: string, { inline = false } = {}): string[] {
	return menus[menu]
		.filter((m) => m.group.startsWith('inline') === inline)
		.filter((m) => regexOf(m.when).test(contextValue))
		.map((m) => m.command);
}

const vm = (state: VmState): VmInfo => ({ id: 'v', name: 'vm', state });

describe.each(['view/item/context', 'webview/context'])('%s menu', (menu) => {
	it('contains no control characters', () => {
		expect(JSON.stringify(menus[menu])).not.toMatch(/\\u00|\\b(?![a-z])/);
		for (const item of menus[menu]) expect([...item.when].every((c) => c.charCodeAt(0) >= 32)).toBe(true);
	});

	it('offers start, consoles and management for a stopped VM', () => {
		expect(commandsFor(menu, vmContextValue(vm('stopped'), caps))).toEqual([
			'vmm.start',
			'vmm.connectGraphical',
			'vmm.connectSerial',
			'vmm.openExternal',
			'vmm.editVm',
			'vmm.deleteVm',
			'vmm.copyId'
		]);
	});

	it('offers shutdown, reboot, stop and consoles for a running VM', () => {
		expect(commandsFor(menu, vmContextValue(vm('running'), caps))).toEqual([
			'vmm.shutdown',
			'vmm.reboot',
			'vmm.stop',
			'vmm.connectGraphical',
			'vmm.connectSerial',
			'vmm.openExternal',
			'vmm.editVm',
			'vmm.deleteVm',
			'vmm.copyId'
		]);
	});

	it('only offers a hard power-off while a shutdown runs', () => {
		const busy = { ...vm('stopping'), operation: 'shutdown' as const };
		expect(commandsFor(menu, vmContextValue(busy, caps))).toEqual([
			'vmm.stop',
			'vmm.connectGraphical',
			'vmm.connectSerial',
			'vmm.openExternal',
			'vmm.editVm',
			'vmm.deleteVm',
			'vmm.copyId'
		]);
		const poweringOff = { ...vm('stopping'), operation: 'stop' as const };
		expect(commandsFor(menu, vmContextValue(poweringOff, caps))).not.toContain('vmm.stop');
	});

	it('only offers actions the provider supports', () => {
		const limited: Capabilities = { ...caps, power: ['start', 'stop'], consoles: [], preview: false, external: false, edit: false, delete: false };
		expect(commandsFor(menu, vmContextValue(vm('running'), limited))).toEqual(['vmm.stop', 'vmm.copyId']);
	});

	it('offers create on nodes and management on clusters', () => {
		expect(commandsFor(menu, nodeContextValue('online', caps))).toContain('vmm.createVm');
		expect(commandsFor(menu, clusterContextValue('connected'))).toEqual(['vmm.reconnectCluster', 'vmm.editCluster', 'vmm.removeCluster']);
		expect(commandsFor(menu, clusterContextValue('connected', { ...caps, consoles: ['rdp'] }))).toEqual(['vmm.reconnectCluster', 'vmm.editCluster', 'vmm.removeCluster', 'vmm.forgetConsoleCredentials']);
	});
});

describe.each(['view/item/context', 'webview/context'])('%s attach and import', (menu) => {
	it('offers attach and import on nodes of providers that support them', () => {
		const plain = commandsFor(menu, nodeContextValue('online', caps));
		expect(plain).not.toContain('vmm.attachRunningVm');
		expect(plain).not.toContain('vmm.importFromFolder');
		const capable = commandsFor(menu, nodeContextValue('online', { ...caps, adopt: true, importFolder: true }));
		expect(capable).toEqual(expect.arrayContaining(['vmm.createVm', 'vmm.attachRunningVm', 'vmm.importFromFolder']));
	});

	it('only offers a power-off for an attached VM without a control channel', () => {
		const blind: VmInfo = { ...vm('running'), origin: 'adopted', controllable: false };
		const commands = commandsFor(menu, vmContextValue(blind, caps));
		expect(commands).toContain('vmm.stop');
		expect(commands).not.toContain('vmm.shutdown');
		expect(commands).not.toContain('vmm.reboot');
		expect(commandsFor(menu, vmContextValue({ ...blind, controllable: true }, caps))).toContain('vmm.shutdown');
	});
});

describe.each(['view/item/context', 'webview/context'])('%s media actions', (menu) => {
	const withMedia: Capabilities = { ...caps, media: true };

	it('offers Change ISO whenever the provider supports media, Eject only with media inserted', () => {
		const empty = commandsFor(menu, vmContextValue(vm('running'), withMedia));
		expect(empty).toContain('vmm.changeMedia');
		expect(empty).not.toContain('vmm.ejectMedia');
		const loaded = commandsFor(menu, vmContextValue({ ...vm('running'), mediaInserted: true }, withMedia));
		expect(loaded).toContain('vmm.ejectMedia');
		expect(loaded.indexOf('vmm.ejectMedia')).toBeLessThan(loaded.indexOf('vmm.changeMedia'));
	});

	it('hides media actions for providers without media support', () => {
		const commands = commandsFor(menu, vmContextValue({ ...vm('running'), mediaInserted: true }, caps));
		expect(commands).not.toContain('vmm.ejectMedia');
		expect(commands).not.toContain('vmm.changeMedia');
	});
});

describe.each(['view/item/context', 'webview/context'])('%s snapshot actions', (menu) => {
	const withSnapshots: Capabilities = { ...caps, snapshots: true };

	it('offers take, revert and delete together, in that order, when the provider supports snapshots', () => {
		for (const state of ['running', 'stopped'] as const) {
			const commands = commandsFor(menu, vmContextValue(vm(state), withSnapshots));
			expect(commands).toEqual(expect.arrayContaining(['vmm.takeSnapshot', 'vmm.revertSnapshot', 'vmm.deleteSnapshot']));
			expect(commands.indexOf('vmm.takeSnapshot')).toBeLessThan(commands.indexOf('vmm.revertSnapshot'));
			expect(commands.indexOf('vmm.revertSnapshot')).toBeLessThan(commands.indexOf('vmm.deleteSnapshot'));
		}
	});

	it('hides them for providers without snapshots', () => {
		const commands = commandsFor(menu, vmContextValue(vm('stopped'), caps));
		expect(commands.filter((c) => c.endsWith('Snapshot'))).toEqual([]);
	});
});

describe.each(['view/item/context', 'webview/context'])('%s ssh action', (menu) => {
	const withDetails: Capabilities = { ...caps, details: true };

	it('offers Remote-SSH on a running VM whose provider reports details, next to the other ways to connect', () => {
		const commands = commandsFor(menu, vmContextValue(vm('running'), withDetails));
		expect(commands).toContain('vmm.connectSsh');
	});

	it('does not offer it on a stopped VM or without details', () => {
		expect(commandsFor(menu, vmContextValue(vm('stopped'), withDetails))).not.toContain('vmm.connectSsh');
		expect(commandsFor(menu, vmContextValue(vm('running'), caps))).not.toContain('vmm.connectSsh');
	});
});

describe.each(['view/item/context', 'webview/context'])('%s clone action', (menu) => {
	it('offers Clone before Delete when the provider can clone, in any state', () => {
		for (const state of ['running', 'stopped'] as const) {
			const commands = commandsFor(menu, vmContextValue(vm(state), { ...caps, clone: true }));
			expect(commands).toContain('vmm.cloneVm');
			expect(commands.indexOf('vmm.cloneVm')).toBeLessThan(commands.indexOf('vmm.deleteVm'));
		}
	});

	it('hides it for providers that cannot', () => {
		expect(commandsFor(menu, vmContextValue(vm('stopped'), caps))).not.toContain('vmm.cloneVm');
	});
});

describe.each(['view/item/context', 'webview/context'])('%s details action', (menu) => {
	it('offers Show Details first in the manage group when the provider reports details or stats', () => {
		const detailed: Capabilities = { ...caps, details: true };
		const commands = commandsFor(menu, vmContextValue(vm('running'), detailed));
		expect(commands).toContain('vmm.openVmDashboard');
		expect(commands.indexOf('vmm.openVmDashboard')).toBeLessThan(commands.indexOf('vmm.editVm'));
		expect(commandsFor(menu, vmContextValue(vm('running'), { ...caps, stats: true }))).toContain('vmm.openVmDashboard');
		expect(commandsFor(menu, vmContextValue(vm('running'), caps))).not.toContain('vmm.openVmDashboard');
	});
});

describe('tree inline eject', () => {
	const withMedia: Capabilities = { ...caps, media: true };
	const inline = (v: VmInfo) => commandsFor('view/item/context', vmContextValue(v, withMedia), { inline: true });

	it('shows a one-click eject on running VMs holding media', () => {
		expect(inline({ ...vm('running'), mediaInserted: true })).toContain('vmm.ejectMedia');
		expect(inline(vm('running'))).not.toContain('vmm.ejectMedia');
		expect(inline({ ...vm('stopped'), mediaInserted: true })).not.toContain('vmm.ejectMedia');
	});
});

describe('tree inline console action', () => {
	const noPreview: Capabilities = { ...caps, consoles: ['vnc', 'serial'], preview: false };
	const inline = (v: VmInfo) => commandsFor('view/item/context', vmContextValue(v, noPreview), { inline: true });

	it('shows the terminal in place of the display for a resource that only has a terminal', () => {
		expect(inline({ ...vm('running'), consoles: ['serial'] })).toEqual(['vmm.connectSerial', 'vmm.shutdown']);
	});

	it('lets the display win when both exist', () => {
		expect(inline({ ...vm('running'), consoles: ['vnc', 'serial'] })).toEqual(['vmm.connectGraphical', 'vmm.shutdown']);
	});

	it('shows nothing for a stopped terminal-only resource, and still offers it in the context menu', () => {
		expect(inline({ ...vm('stopped'), consoles: ['serial'] })).toEqual(['vmm.start']);
		expect(commandsFor('view/item/context', vmContextValue({ ...vm('running'), consoles: ['serial'] }, noPreview))).toContain('vmm.connectSerial');
	});
});

describe('tree inline actions', () => {
	it('shows start on stopped and connect/shutdown on running VMs', () => {
		expect(commandsFor('view/item/context', vmContextValue(vm('saved'), caps), { inline: true })).toEqual(['vmm.start']);
		expect(commandsFor('view/item/context', vmContextValue(vm('running'), caps), { inline: true })).toEqual([
			'vmm.connectGraphical',
			'vmm.shutdown'
		]);
	});
});

describe('sign out', () => {
	const signedIn = clusterContextValue('connected', { ...caps, signOut: true });

	it('is offered only for a connected cluster whose provider has a session', () => {
		expect(commandsFor('view/item/context', signedIn)).toContain('vmm.signOut');
		expect(commandsFor('view/item/context', signedIn, { inline: true })).toContain('vmm.signOut');
		expect(commandsFor('webview/context', signedIn)).toContain('vmm.signOut');
		for (const value of [clusterContextValue('connected', caps), clusterContextValue('connected'), clusterContextValue('disconnected', { ...caps, signOut: true }), clusterContextValue('error')]) {
			expect(commandsFor('view/item/context', value)).not.toContain('vmm.signOut');
			expect(commandsFor('webview/context', value)).not.toContain('vmm.signOut');
		}
	});

	it('keeps the other cluster menu items working with the extra flag', () => {
		expect(commandsFor('view/item/context', signedIn)).toEqual(expect.arrayContaining(['vmm.reconnectCluster', 'vmm.editCluster', 'vmm.removeCluster']));
		expect(commandsFor('view/item/context', clusterContextValue('missingProvider'), { inline: true })).toContain('vmm.installProviders');
	});
});

describe('forget console sign-in', () => {
	const rdp: Capabilities = { ...caps, consoles: ['rdp', 'serial'] };

	it('is offered only for clusters whose provider opens RDP consoles', () => {
		for (const menu of ['view/item/context', 'webview/context']) {
			expect(commandsFor(menu, clusterContextValue('connected', rdp))).toContain('vmm.forgetConsoleCredentials');
			expect(commandsFor(menu, clusterContextValue('connected', caps))).not.toContain('vmm.forgetConsoleCredentials');
			expect(commandsFor(menu, clusterContextValue('connected', { ...caps, consoles: ['vnc', 'serial'] }))).not.toContain('vmm.forgetConsoleCredentials');
		}
	});
});

describe('cancel sign-in', () => {
	it('is offered on a cluster that is still connecting, and only then', () => {
		const connecting = clusterContextValue('connecting');
		expect(commandsFor('view/item/context', connecting, { inline: true })).toContain('vmm.cancelConnect');
		for (const menu of ['view/item/context', 'webview/context']) {
			expect(commandsFor(menu, connecting)).toContain('vmm.cancelConnect');
			for (const status of ['connected', 'disconnected', 'error'] as const) {
				expect(commandsFor(menu, clusterContextValue(status))).not.toContain('vmm.cancelConnect');
			}
		}
		for (const status of ['connected', 'disconnected', 'error'] as const) {
			expect(commandsFor('view/item/context', clusterContextValue(status), { inline: true })).not.toContain('vmm.cancelConnect');
		}
	});
});

describe('overview menu', () => {
	// Same check as the VS Code integration test, so a missing entry fails fast and locally.
	it('mirrors the tree menu: same commands, same state rules, same order', () => {
		const tree = menus['view/item/context']
			.filter((m) => !m.group.startsWith('inline'))
			.map((m) => [m.command, m.when.replace('view == vmm.clusters && viewItem', '')]);
		const overview = menus['webview/context'].map((m) => [m.command, m.when.replace('webviewId == vmm.overview && vmmItem', '')]);
		expect(overview).toEqual(tree);
	});
});
