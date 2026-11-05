/**
 * Discrete Device Assignment (DDA): handing a PCI(e) device of the host to a Hyper-V VM. Pure module,
 * unit tested. EXPERIMENTAL: the scripts are written from the Hyper-V documentation and have not been
 * run on a Windows Server host.
 */
import type { PassthroughDevice, PassthroughInfo, PassthroughPlan } from '@vmm/sdk';
import { asArray } from './inspect';

/** `PCIROOT(0)#PCI(0300)#PCI(0000)`: what `Dismount-VMHostAssignableDevice` takes. */
const LOCATION_PATH = /^PCIROOT\(\w+\)(#PCI\(\w+\))+$/i;

export function isLocationPath(value: string): boolean {
	return LOCATION_PATH.test(value);
}

export function assertLocationPath(value: string): string {
	if (!isLocationPath(value)) throw new Error(`Invalid device location path: ${value}`);
	return value;
}

export interface RawDdaDevice {
	LocationPath: string;
	Name: string | null;
	Class: string | null;
	InstanceId: string | null;
	/** Assigned to the VM in question. */
	Assigned: boolean;
	/** Dismounted from the host (free to assign) but not given to this VM. */
	Dismounted: boolean;
}

export interface RawDdaInfo {
	/** Windows Server: DDA is not offered on client SKUs. */
	IsServer: boolean;
	/** Whether the Hyper-V PowerShell module has the DDA cmdlets. */
	HasCmdlets: boolean;
	Devices: RawDdaDevice[] | RawDdaDevice | null;
}

const NOT_SERVER = 'Discrete Device Assignment needs Windows Server 2016 or later; client Windows editions do not offer it.';
const NO_CMDLETS = 'This Hyper-V host does not have the device assignment cmdlets (Add-VMAssignableDevice).';

export function toPassthroughInfo(raw: RawDdaInfo): PassthroughInfo {
	const usb = { supported: false, reason: 'Hyper-V does not pass USB devices through. Use RDP device redirection, or a USB-over-network tool.' };
	if (!raw.IsServer) return { usb, pci: { supported: false, experimental: true, reason: NOT_SERVER }, devices: [] };
	if (!raw.HasCmdlets) return { usb, pci: { supported: false, experimental: true, reason: NO_CMDLETS }, devices: [] };
	const devices: PassthroughDevice[] = asArray(raw.Devices)
		.filter((d) => isLocationPath(d.LocationPath))
		.map((d) => ({
			id: `pci:${d.LocationPath}`,
			kind: 'pci' as const,
			label: d.Name || d.Class || 'PCI device',
			address: d.LocationPath,
			detail: [d.Class, d.InstanceId].filter(Boolean).join(' · ') || undefined,
			attached: d.Assigned
		}));
	return { usb, pci: { supported: true, experimental: true }, devices };
}

/** The device location path of a `pci:` handle. */
export function parseDeviceId(deviceId: string): string {
	if (!deviceId.startsWith('pci:')) throw new Error(`Unsupported device: ${deviceId}`);
	return assertLocationPath(deviceId.slice(4));
}

export function planAttach(vmName: string, locationPath: string): PassthroughPlan {
	return {
		title: `Assign ${locationPath} to ${vmName}`,
		steps: [
			`Set-VM -GuestControlledCacheTypes $true -LowMemoryMappedIoSpace 3Gb -HighMemoryMappedIoSpace 33280Mb (the VM must be off)`,
			`Dismount-VMHostAssignableDevice -Force -LocationPath '${locationPath}' (the host stops using the device)`,
			`Add-VMAssignableDevice -LocationPath '${locationPath}' -VM ${vmName}`
		],
		warnings: [
			'The host loses the device while it is assigned; a device the host needs (its boot disk, its only network adapter or display) takes the host down with it.',
			'The device driver must be installed in the guest. Some devices (GPUs, NICs) additionally need vendor support for assignment.',
			'The VM will not be able to live migrate or save its state while it holds a device.'
		],
		needsConfirmation: true,
		experimental: true
	};
}

export function planDetach(vmName: string, locationPath: string): PassthroughPlan {
	return {
		title: `Return ${locationPath} to the host`,
		steps: [`Remove-VMAssignableDevice -LocationPath '${locationPath}' -VM ${vmName}`, `Mount-VMHostAssignableDevice -LocationPath '${locationPath}' (the host uses the device again)`],
		warnings: [],
		needsConfirmation: true,
		experimental: true
	};
}
