import type { DiskDevice, HostDevice, NicDevice } from '@vmm/sdk';

type Config = Record<string, unknown>;

const UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `32G` -> bytes. Proxmox sizes carry a binary unit suffix; a bare number is bytes. */
export function parseSize(value: string | undefined): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([KMGT])?B?$/i.exec(value ?? '');
	return match ? Math.round(Number(match[1]) * (match[2] ? UNITS[match[2].toUpperCase()]! : 1)) : undefined;
}

/** `virtio=BC:..,bridge=vmbr0,tag=5` -> `{ virtio: 'BC:..', bridge: 'vmbr0', tag: '5' }`, keeping the first bare item under `_`. */
export function parseOptions(value: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	String(value ?? '').split(',').forEach((part, index) => {
		const at = part.indexOf('=');
		if (at < 0) { if (index === 0) result._ = part; return; }
		result[part.slice(0, at)] = part.slice(at + 1);
	});
	return result;
}

const entries = (config: Config, pattern: RegExp) => Object.entries(config).filter(([key]) => pattern.test(key)).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

/** Disks and CD/DVD drives of a VM, or the root file system and mount points of a container. */
export function diskDevices(config: Config, container: boolean): DiskDevice[] {
	const pattern = container ? /^(rootfs|mp\d+)$/ : /^(scsi|virtio|sata|ide)\d+$/;
	return entries(config, pattern).map(([key, raw]): DiskDevice => {
		const options = parseOptions(raw);
		const volume = options._ ?? String(raw).split(',')[0]!;
		const cdrom = options.media === 'cdrom';
		const empty = volume === 'none' || volume === 'cdrom';
		return {
			id: key,
			kind: cdrom ? 'cdrom' : 'disk',
			label: container ? (key === 'rootfs' ? 'Root file system' : `Mount ${key.slice(2)}`) : `${key.replace(/\d+$/, '').toUpperCase()} ${key.match(/\d+$/)![0]}`,
			path: empty ? undefined : volume,
			sizeBytes: parseSize(options.size),
			bus: container ? undefined : key.replace(/\d+$/, ''),
			readOnly: options.ro === '1' ? true : undefined,
			removable: cdrom ? true : undefined
		};
	});
}

/** Network adapters. IP addresses come from the guest (see `mergeAddresses`) or, for a container, a static `ip=`. */
export function nicDevices(config: Config, container: boolean): NicDevice[] {
	return entries(config, /^net\d+$/).map(([key, raw]): NicDevice => {
		const options = parseOptions(raw);
		const model = container ? undefined : Object.keys(options).find((k) => /^(virtio|e1000e?|rtl8139|vmxnet3|i82551|i82557b|i82559er|ne2k_pci|ne2k_isa|pcnet)/.test(k));
		const mac = container ? options.hwaddr : model ? options[model] : options.macaddr;
		const staticIp = container && options.ip && !/^(dhcp|manual)$/.test(options.ip) ? [options.ip.replace(/\/\d+$/, '')] : undefined;
		return {
			id: key,
			label: container ? (options.name ?? key) : key,
			model,
			mac: mac?.toUpperCase(),
			network: [options.bridge, options.tag ? `VLAN ${options.tag}` : undefined].filter(Boolean).join(' · ') || undefined,
			ipAddresses: staticIp,
			connected: options.link_down === '1' ? false : undefined
		};
	});
}

/** PCI and USB passthrough entries, and serial ports. */
export function hostDevices(config: Config): HostDevice[] {
	const pci = entries(config, /^hostpci\d+$/).map(([key, raw]): HostDevice => {
		const options = parseOptions(raw);
		return { id: key, kind: 'pci', label: options.mapping ? `PCI ${options.mapping}` : 'PCI device', address: options._ ?? options.host ?? options.mapping, description: options.pcie === '1' ? 'PCIe' : undefined };
	});
	const usb = entries(config, /^usb\d+$/).map(([key, raw]): HostDevice => {
		const options = parseOptions(raw);
		return { id: key, kind: 'usb', label: 'USB device', address: options.host ?? options.mapping ?? options._ };
	});
	const serial = entries(config, /^serial\d+$/).map(([key, raw]): HostDevice => ({ id: key, kind: 'other', label: `Serial port ${key.slice(6)}`, description: String(raw) === 'socket' ? 'Socket' : String(raw) }));
	return [...pci, ...usb, ...serial];
}

const usable = (ip: string) => !/^(127\.|::1$|fe80:)/i.test(ip) && ip.length > 0;

/** Addresses by lower-case MAC, from the QEMU guest agent's `network-get-interfaces`. */
export function agentAddresses(reply: unknown): Map<string, string[]> {
	const list = (reply as { result?: unknown } | undefined)?.result ?? reply;
	const result = new Map<string, string[]>();
	if (!Array.isArray(list)) return result;
	for (const iface of list as Array<Record<string, unknown>>) {
		const mac = String(iface['hardware-address'] ?? '').toLowerCase();
		const ips = ((iface['ip-addresses'] as Array<Record<string, unknown>> | undefined) ?? []).map((a) => String(a['ip-address'] ?? '')).filter(usable);
		if (mac && ips.length) result.set(mac, ips);
	}
	return result;
}

/** Addresses by lower-case MAC, from a container's `interfaces`. */
export function containerAddresses(reply: unknown): Map<string, string[]> {
	const result = new Map<string, string[]>();
	if (!Array.isArray(reply)) return result;
	for (const iface of reply as Array<Record<string, unknown>>) {
		const mac = String(iface.hwaddr ?? iface['hardware-address'] ?? '').toLowerCase();
		const ips = [iface.inet, iface.inet6].map((v) => String(v ?? '').replace(/\/\d+$/, '')).filter(usable);
		if (mac && ips.length) result.set(mac, ips);
	}
	return result;
}

/** Puts guest-reported addresses on the adapters with the same MAC. */
export function mergeAddresses(nics: NicDevice[], reported: Map<string, string[]>): NicDevice[] {
	return nics.map((nic) => {
		const ips = reported.get((nic.mac ?? '').toLowerCase());
		return ips ? { ...nic, ipAddresses: [...new Set([...(nic.ipAddresses ?? []), ...ips])] } : nic;
	});
}

export function allAddresses(reported: Map<string, string[]>): string[] {
	return [...new Set([...reported.values()].flat())];
}
