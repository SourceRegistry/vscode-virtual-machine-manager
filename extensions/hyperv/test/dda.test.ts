import { describe, expect, it } from 'vitest';
import { assertLocationPath, isLocationPath, parseDeviceId, planAttach, planDetach, toPassthroughInfo } from '../src/dda';

const PATH = 'PCIROOT(0)#PCI(0300)#PCI(0000)';

describe('location paths', () => {
	it('accepts what Windows reports and nothing that could carry a command', () => {
		expect(isLocationPath(PATH)).toBe(true);
		expect(isLocationPath('PCIROOT(0)#PCI(0100)#PCI(0000)#PCI(0800)')).toBe(true);
		expect(isLocationPath(`${PATH}'; Remove-Item C:\\ -Recurse #`)).toBe(false);
		expect(isLocationPath('PCI(0300)')).toBe(false);
		expect(() => assertLocationPath('x')).toThrow('Invalid device location path');
	});

	it('parses device handles', () => {
		expect(parseDeviceId(`pci:${PATH}`)).toBe(PATH);
		expect(() => parseDeviceId('usb:046d:c52b')).toThrow('Unsupported device');
		expect(() => parseDeviceId('pci:evil')).toThrow('Invalid device location path');
	});
});

describe('toPassthroughInfo', () => {
	const device = { LocationPath: PATH, Name: 'NVIDIA RTX A2000', Class: 'Display', InstanceId: 'PCI\\VEN_10DE&DEV_2531\\4&1', Assigned: false, Dismounted: false };

	it('gates on Windows Server and the cmdlets, with the reason', () => {
		expect(toPassthroughInfo({ IsServer: false, HasCmdlets: false, Devices: null }).pci).toMatchObject({ supported: false, experimental: true, reason: expect.stringMatching(/Windows Server/) });
		expect(toPassthroughInfo({ IsServer: true, HasCmdlets: false, Devices: null }).pci.reason).toMatch(/cmdlets/);
	});

	it('never offers USB', () => {
		expect(toPassthroughInfo({ IsServer: true, HasCmdlets: true, Devices: [] }).usb.supported).toBe(false);
	});

	it('maps devices, tolerating single-object output and dropping odd paths', () => {
		const info = toPassthroughInfo({ IsServer: true, HasCmdlets: true, Devices: [device, { ...device, LocationPath: 'weird', Name: 'x' }] });
		expect(info.pci).toEqual({ supported: true, experimental: true });
		expect(info.devices).toEqual([{ id: `pci:${PATH}`, kind: 'pci', label: 'NVIDIA RTX A2000', address: PATH, detail: 'Display · PCI\\VEN_10DE&DEV_2531\\4&1', attached: false }]);
		expect(toPassthroughInfo({ IsServer: true, HasCmdlets: true, Devices: { ...device, Assigned: true } }).devices[0]?.attached).toBe(true);
	});
});

describe('plans', () => {
	it('list every host change and require confirmation', () => {
		const attach = planAttach('gpu-vm', PATH);
		expect(attach).toMatchObject({ needsConfirmation: true, experimental: true });
		expect(attach.steps.join('\n')).toContain(`Dismount-VMHostAssignableDevice -Force -LocationPath '${PATH}'`);
		expect(attach.warnings.length).toBeGreaterThan(0);
		const detach = planDetach('gpu-vm', PATH);
		expect(detach.steps.join('\n')).toContain('Mount-VMHostAssignableDevice');
		expect(detach.needsConfirmation).toBe(true);
	});
});
