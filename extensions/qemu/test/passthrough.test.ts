import { describe, expect, it } from 'vitest';
import {
	assessVfio,
	bindScript,
	parseLsusb,
	parseSystemProfilerUsb,
	parseUsbDeviceId,
	pciClassName,
	releaseScript,
	usbAddArguments,
	usbDeviceId,
	usbKey,
	vfioDeviceArgument,
	type PciHostDevice
} from '../src/passthrough';

describe('USB listing', () => {
	it('parses lsusb and drops root hubs', () => {
		const text = ['Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub', 'Bus 001 Device 004: ID 046d:c52b Logitech, Inc. Unifying Receiver', 'noise', 'Bus 002 Device 002: ID 0951:1666 '].join('\n');
		expect(parseLsusb(text)).toEqual([
			{ bus: 1, address: 4, vendorId: 0x046d, productId: 0xc52b, name: 'Logitech, Inc. Unifying Receiver' },
			{ bus: 2, address: 2, vendorId: 0x0951, productId: 0x1666, name: 'USB device' }
		]);
	});

	it('parses system_profiler recursively, skipping hubs and id-less controllers', () => {
		const json = JSON.stringify({
			SPUSBDataType: [
				{ _name: 'USB31Bus', _items: [{ _name: 'USB3.0 Hub', vendor_id: '0x2109 (VIA)', product_id: '0x0817', _items: [{ _name: 'SanDisk Cruzer', vendor_id: '0x0781  (SanDisk Corporation)', product_id: '0x5567' }] }] }
			]
		});
		expect(parseSystemProfilerUsb(json)).toEqual([{ vendorId: 0x0781, productId: 0x5567, name: 'SanDisk Cruzer' }]);
		expect(parseSystemProfilerUsb('not json')).toEqual([]);
	});

	it('builds the QMP device_add arguments and parses the id back', () => {
		const device = { vendorId: 0x046d, productId: 0xc52b };
		expect(usbKey(device)).toBe('046d:c52b');
		expect(usbDeviceId(device)).toBe('vmm-usb-046d-c52b');
		expect(usbAddArguments(device)).toEqual({ driver: 'usb-host', id: 'vmm-usb-046d-c52b', vendorid: 0x046d, productid: 0xc52b });
		expect(parseUsbDeviceId('vmm-usb-046d-c52b')).toEqual(device);
		expect(parseUsbDeviceId('usb-tablet')).toBeUndefined();
	});
});

const gpu: PciHostDevice = { address: '0000:01:00.0', vendorId: 0x10de, deviceId: 0x2504, classCode: 0x030000, driver: 'nouveau', iommuGroup: 14 };
const audio: PciHostDevice = { address: '0000:01:00.1', vendorId: 0x10de, deviceId: 0x228e, classCode: 0x040300, driver: 'snd_hda_intel', iommuGroup: 14 };
const bridge: PciHostDevice = { address: '0000:00:01.0', vendorId: 0x8086, deviceId: 0x1901, classCode: 0x060400, driver: 'pcieport', iommuGroup: 1 };
const nic: PciHostDevice = { address: '0000:03:00.0', vendorId: 0x8086, deviceId: 0x1533, classCode: 0x020000, driver: 'igb', iommuGroup: 20 };

describe('VFIO assessment', () => {
	it('names classes', () => {
		expect(pciClassName(0x030000)).toBe('VGA controller');
		expect(pciClassName(0x020000)).toBe('Network controller');
		expect(pciClassName(0x0c0330)).toBe('USB controller');
		expect(pciClassName(0xff0000)).toBe('PCI device');
	});

	it('is not eligible without an IOMMU group', () => {
		expect(assessVfio(nic, [nic], false)).toMatchObject({ eligible: false });
		expect(assessVfio({ ...nic, iommuGroup: undefined }, [nic], true).eligible).toBe(false);
	});

	it('never offers bridges', () => {
		expect(assessVfio(bridge, [bridge], true).eligible).toBe(false);
	});

	it('warns about group peers, host drivers and the boot display', () => {
		const result = assessVfio({ ...gpu, bootVga: true }, [gpu, audio, bridge], true);
		expect(result.eligible).toBe(true);
		expect(result.groupPeers.map((p) => p.address)).toEqual(['0000:01:00.1']);
		expect(result.warnings.join('\n')).toMatch(/IOMMU group 14 with 0000:01:00\.1/);
		expect(result.warnings.join('\n')).toMatch(/must be bound to vfio-pci/);
		expect(result.warnings.join('\n')).toMatch(/booted with/);
		expect(result.warnings.join('\n')).toMatch(/"nouveau"/);
	});

	it('has no warnings for a lone device already on vfio-pci', () => {
		expect(assessVfio({ ...nic, driver: 'vfio-pci' }, [nic, bridge], true)).toMatchObject({ eligible: true, warnings: [] });
	});
});

describe('privileged scripts', () => {
	it('binds through driver_override and gives the user the group node', () => {
		const script = bindScript('0000:01:00.0', 14, 1000).join('\n');
		expect(script).toContain('modprobe vfio-pci');
		expect(script).toContain('echo vfio-pci > /sys/bus/pci/devices/0000:01:00.0/driver_override');
		expect(script).toContain('chown 1000 /dev/vfio/14');
	});

	it('releases by clearing the override and re-probing', () => {
		const script = releaseScript('0000:01:00.0').join('\n');
		expect(script).toContain('echo > /sys/bus/pci/devices/0000:01:00.0/driver_override');
		expect(script).toContain('drivers_probe');
	});

	it('refuses anything that is not a plain PCI address, group or uid', () => {
		expect(() => bindScript('0000:01:00.0; rm -rf /', 1, 1000)).toThrow('Invalid PCI address');
		expect(() => bindScript('0000:01:00.0', -1, 1000)).toThrow('IOMMU group');
		expect(() => bindScript('0000:01:00.0', 1, NaN)).toThrow('user id');
		expect(() => releaseScript('$(id)')).toThrow('Invalid PCI address');
		expect(() => vfioDeviceArgument('x,y')).toThrow('Invalid PCI address');
		expect(vfioDeviceArgument('0000:01:00.0')).toBe('vfio-pci,host=0000:01:00.0');
	});
});
