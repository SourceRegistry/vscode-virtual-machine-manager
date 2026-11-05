import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { findPackage, packages, touchesPackage } from '../scripts/packages.mjs';

const core = findPackage('core');
const qemu = findPackage('qemu');

describe('release packages', () => {
	it('lists the core first, then every provider', () => {
		expect(packages[0].id).toBe('core');
		expect(packages.map((p: { id: string }) => p.id).sort()).toEqual(['core', 'hyperv', 'proxmox', 'qemu']);
	});

	it('gives every package its own tag format', () => {
		const formats = packages.map((p: { tagFormat: string }) => p.tagFormat);
		expect(new Set(formats).size).toBe(formats.length);
		expect(qemu.tagFormat).toBe('vm-manager-qemu-v${version}');
	});

	it('resolves a package from its id or release tag', () => {
		expect(findPackage('v1.2.3').id).toBe('core');
		expect(findPackage('vm-manager-qemu-v0.4.0').id).toBe('qemu');
		expect(findPackage('vm-manager-hyperv-v1.0.0-beta.1').id).toBe('hyperv');
		expect(() => findPackage('vm-manager-nope-v1.0.0')).toThrow();
	});

	it('assigns commits to the packages whose files they touch', () => {
		expect(touchesPackage(['extensions/qemu/src/detect.ts'], qemu)).toBe(true);
		expect(touchesPackage(['extensions/qemu/src/detect.ts'], core)).toBe(false);
		expect(touchesPackage(['extensions/proxmox/src/session.ts'], qemu)).toBe(false);
		expect(touchesPackage(['src/extension/extension.ts'], core)).toBe(true);
		expect(touchesPackage(['src/extension/extension.ts'], qemu)).toBe(false);
	});

	it('releases the core and every provider for a change to the shared SDK', () => {
		for (const pkg of packages) expect(touchesPackage(['packages/sdk/src/index.ts'], pkg)).toBe(true);
	});

	it('releases the core alongside a provider when one commit touches both', () => {
		const files = ['extensions/qemu/src/QemuProvider.ts', 'src/extension/commands/index.ts'];
		expect(touchesPackage(files, core)).toBe(true);
		expect(touchesPackage(files, qemu)).toBe(true);
		expect(touchesPackage(files, findPackage('hyperv'))).toBe(false);
	});
});
