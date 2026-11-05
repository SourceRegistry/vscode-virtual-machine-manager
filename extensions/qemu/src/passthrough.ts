/**
 * Host device passthrough: USB hot-plug and Linux VFIO. Pure module (parsing, validation, command and
 * script building; the I/O lives in the provider), unit tested.
 */

// ---- USB --------------------------------------------------------------------------------------

export interface UsbHostDevice {
	vendorId: number;
	productId: number;
	name: string;
	bus?: number;
	address?: number;
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/** `046d:c52b`. */
export function usbKey(device: Pick<UsbHostDevice, 'vendorId' | 'productId'>): string {
	return `${hex4(device.vendorId)}:${hex4(device.productId)}`;
}

/** Root hubs (Linux Foundation) cannot be passed through and only add noise. */
function isRootHub(vendorId: number): boolean {
	return vendorId === 0x1d6b;
}

/** `lsusb` lines: `Bus 001 Device 004: ID 046d:c52b Logitech, Inc. Unifying Receiver`. */
export function parseLsusb(text: string): UsbHostDevice[] {
	const devices: UsbHostDevice[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)$/i.exec(line);
		if (!match) continue;
		const vendorId = parseInt(match[3]!, 16);
		if (isRootHub(vendorId)) continue;
		devices.push({ bus: Number(match[1]), address: Number(match[2]), vendorId, productId: parseInt(match[4]!, 16), name: match[5]!.trim() || 'USB device' });
	}
	return devices;
}

interface ProfilerItem {
	_name?: string;
	vendor_id?: string;
	product_id?: string;
	location_id?: string;
	_items?: ProfilerItem[];
}

/** `system_profiler SPUSBDataType -json` (macOS); hubs and controllers without ids are skipped. */
export function parseSystemProfilerUsb(json: string): UsbHostDevice[] {
	let root: { SPUSBDataType?: ProfilerItem[] };
	try {
		root = JSON.parse(json) as typeof root;
	} catch {
		return [];
	}
	const devices: UsbHostDevice[] = [];
	const id = (value: string | undefined) => {
		const match = /0x([0-9a-f]{1,4})/i.exec(value ?? '');
		return match ? parseInt(match[1]!, 16) : undefined;
	};
	const walk = (items: ProfilerItem[] | undefined) => {
		for (const item of items ?? []) {
			const vendorId = id(item.vendor_id);
			const productId = id(item.product_id);
			if (vendorId !== undefined && productId !== undefined && !isRootHub(vendorId) && !/\bhub\b/i.test(item._name ?? '')) {
				devices.push({ vendorId, productId, name: item._name?.trim() || 'USB device' });
			}
			walk(item._items);
		}
	};
	walk(root.SPUSBDataType);
	return devices;
}

/** Name of the QEMU device a hot-plugged host USB device gets; also how attached ones are found again. */
export function usbDeviceId(device: Pick<UsbHostDevice, 'vendorId' | 'productId'>): string {
	return `vmm-usb-${hex4(device.vendorId)}-${hex4(device.productId)}`;
}

export const USB_ID_PREFIX = 'vmm-usb-';

/** QMP `device_add` arguments. */
export function usbAddArguments(device: Pick<UsbHostDevice, 'vendorId' | 'productId'>): Record<string, unknown> {
	return { driver: 'usb-host', id: usbDeviceId(device), vendorid: device.vendorId, productid: device.productId };
}

/** Parses a `vmm-usb-046d-c52b` id back into its numbers. */
export function parseUsbDeviceId(id: string): { vendorId: number; productId: number } | undefined {
	const match = /^vmm-usb-([0-9a-f]{4})-([0-9a-f]{4})$/.exec(id);
	return match ? { vendorId: parseInt(match[1]!, 16), productId: parseInt(match[2]!, 16) } : undefined;
}

// ---- PCI / VFIO (Linux) -----------------------------------------------------------------------

export interface PciHostDevice {
	/** `0000:01:00.0` */
	address: string;
	vendorId: number;
	deviceId: number;
	/** 24-bit class code, e.g. 0x030000 (VGA controller). */
	classCode: number;
	/** Kernel driver currently bound, undefined when none. */
	driver?: string;
	iommuGroup?: number;
	/** The firmware used it as the boot display. */
	bootVga?: boolean;
}

export const PCI_ADDRESS = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/;

const PCI_CLASSES: Record<number, string> = {
	0x00: 'Unclassified device',
	0x01: 'Storage controller',
	0x02: 'Network controller',
	0x03: 'Display controller',
	0x04: 'Multimedia controller',
	0x05: 'Memory controller',
	0x06: 'Bridge',
	0x07: 'Communication controller',
	0x08: 'System peripheral',
	0x09: 'Input device',
	0x0c: 'Serial bus controller',
	0x0d: 'Wireless controller',
	0x12: 'Processing accelerator'
};

export function pciClassName(classCode: number): string {
	if (classCode >> 8 === 0x0300) return 'VGA controller';
	if (classCode >> 8 === 0x0302) return '3D controller';
	if (classCode >> 8 === 0x0403) return 'Audio device';
	if (classCode >> 8 === 0x0c03) return 'USB controller';
	if (classCode >> 8 === 0x0108) return 'NVMe controller';
	return PCI_CLASSES[classCode >> 16] ?? 'PCI device';
}

/** Bridges and host controllers are never passed through; they only matter as IOMMU group peers. */
export function isBridge(device: PciHostDevice): boolean {
	return device.classCode >> 16 === 0x06;
}

export interface VfioAssessment {
	/** The device may be offered at all. */
	eligible: boolean;
	warnings: string[];
	/** Other (non-bridge) devices in the same IOMMU group that must go to the guest together. */
	groupPeers: PciHostDevice[];
}

/** Judges a candidate against the host's devices. `iommuEnabled`: `/sys/kernel/iommu_groups` has entries. */
export function assessVfio(device: PciHostDevice, all: readonly PciHostDevice[], iommuEnabled: boolean): VfioAssessment {
	const warnings: string[] = [];
	if (!iommuEnabled || device.iommuGroup === undefined) {
		return { eligible: false, warnings: ['The IOMMU is not enabled (boot with intel_iommu=on or amd_iommu=on, and enable VT-d/AMD-Vi in the firmware).'], groupPeers: [] };
	}
	if (isBridge(device)) return { eligible: false, warnings: ['Bridges and host controllers cannot be passed through.'], groupPeers: [] };
	const peers = all.filter((d) => d.iommuGroup === device.iommuGroup && d.address !== device.address && !isBridge(d));
	if (peers.length) {
		const bound = peers.filter((p) => p.driver !== 'vfio-pci');
		warnings.push(
			`Shares IOMMU group ${device.iommuGroup} with ${peers.map((p) => `${p.address} (${pciClassName(p.classCode)})`).join(', ')}. The whole group goes to the guest; ${bound.length ? 'those devices stop working on the host too and must be bound to vfio-pci as well' : 'they are already bound to vfio-pci'}.`
		);
	}
	if (device.bootVga) warnings.push('This is the display the host booted with. Passing it through blanks the host screen.');
	if (device.driver && device.driver !== 'vfio-pci') warnings.push(`The host driver "${device.driver}" is unbound from this device: it stops working on the host until it is returned.`);
	return { eligible: true, warnings, groupPeers: peers };
}

/** Checks everything that ends up inside a privileged shell command. */
function assertSafe(address: string, group: number | undefined, uid: number | undefined): void {
	if (!PCI_ADDRESS.test(address)) throw new Error(`Invalid PCI address: ${address}`);
	if (group !== undefined && !(Number.isInteger(group) && group >= 0)) throw new Error('Invalid IOMMU group');
	if (uid !== undefined && !(Number.isInteger(uid) && uid >= 0)) throw new Error('Invalid user id');
}

const SYSFS = '/sys/bus/pci';

/**
 * Root script that hands a device to `vfio-pci` and lets the user open it. Shown to the user verbatim
 * before it runs, so it stays short and has no variable parts beyond the validated address.
 */
export function bindScript(address: string, group: number, uid: number): string[] {
	assertSafe(address, group, uid);
	return [
		'set -e',
		'modprobe vfio-pci',
		`echo vfio-pci > ${SYSFS}/devices/${address}/driver_override`,
		`if [ -e ${SYSFS}/devices/${address}/driver ]; then echo ${address} > ${SYSFS}/devices/${address}/driver/unbind; fi`,
		`echo ${address} > ${SYSFS}/drivers_probe`,
		`chown ${uid} /dev/vfio/${group}`
	];
}

/** Root script that gives the device back to its normal host driver. */
export function releaseScript(address: string): string[] {
	assertSafe(address, undefined, undefined);
	return [
		'set -e',
		`echo > ${SYSFS}/devices/${address}/driver_override`,
		`if [ -e ${SYSFS}/devices/${address}/driver ]; then echo ${address} > ${SYSFS}/devices/${address}/driver/unbind; fi`,
		`echo ${address} > ${SYSFS}/drivers_probe`
	];
}

/** `-device` argument for a VFIO device. */
export function vfioDeviceArgument(address: string): string {
	assertSafe(address, undefined, undefined);
	return `vfio-pci,host=${address}`;
}
