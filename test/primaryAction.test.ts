import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@vmm/sdk';
import { primaryAction } from '../src/shared/primaryAction';

const caps: Capabilities = { create: true, edit: true, delete: true, power: ['start'], consoles: ['vnc', 'serial'], preview: false, external: true, stats: true };

describe('primaryAction', () => {
	it('opens the terminal of a running resource that only has one (an LXC container)', () => {
		expect(primaryAction({ state: 'running', consoles: ['serial'] }, caps)).toBe('vmm.connectSerial');
	});

	it('opens the details of a resource with a graphical console', () => {
		expect(primaryAction({ state: 'running', consoles: ['vnc', 'serial'] }, caps)).toBe('vmm.openVmDashboard');
		expect(primaryAction({ state: 'running' }, caps)).toBe('vmm.openVmDashboard');
		expect(primaryAction({ state: 'running', consoles: ['serial'] }, { ...caps, preview: true })).toBe('vmm.openVmDashboard');
		expect(primaryAction({ state: 'running', consoles: ['rdp', 'serial'] }, caps)).toBe('vmm.openVmDashboard');
	});

	it('falls back to the details when the terminal-only resource is not running', () => {
		expect(primaryAction({ state: 'stopped', consoles: ['serial'] }, caps)).toBe('vmm.openVmDashboard');
		expect(primaryAction({ state: 'stopped', consoles: ['serial'] }, { ...caps, stats: false })).toBeUndefined();
	});

	it('does nothing for providers without details or terminals', () => {
		expect(primaryAction({ state: 'running', consoles: ['vnc'] }, { ...caps, stats: false })).toBeUndefined();
		expect(primaryAction({ state: 'running' }, undefined)).toBeUndefined();
	});
});
