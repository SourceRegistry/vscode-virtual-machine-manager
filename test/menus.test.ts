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
		expect(commandsFor(menu, clusterContextValue('connected'))).toEqual([
			'vmm.reconnectCluster',
			'vmm.editCluster',
			'vmm.removeCluster',
			'vmm.forgetConsoleCredentials'
		]);
	});
});

describe.each(['view/item/context', 'webview/context'])('%s serial console', (menu) => {
	it('is offered only for a resource without a display (LXC), not next to a graphical console', () => {
		const terminalOnly: Capabilities = { ...caps, consoles: ['vnc', 'serial'], preview: false };
		expect(commandsFor(menu, vmContextValue({ ...vm('running'), consoles: ['serial'] }, terminalOnly))).toContain('vmm.connectSerial');
		const withDisplay = commandsFor(menu, vmContextValue({ ...vm('running'), consoles: ['vnc', 'serial'] }, terminalOnly));
		expect(withDisplay).toContain('vmm.connectGraphical');
		expect(withDisplay).not.toContain('vmm.connectSerial');
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

describe('tree inline actions', () => {
	it('shows start on stopped and connect/shutdown on running VMs', () => {
		expect(commandsFor('view/item/context', vmContextValue(vm('saved'), caps), { inline: true })).toEqual(['vmm.start']);
		expect(commandsFor('view/item/context', vmContextValue(vm('running'), caps), { inline: true })).toEqual([
			'vmm.connectGraphical',
			'vmm.shutdown'
		]);
	});
});
