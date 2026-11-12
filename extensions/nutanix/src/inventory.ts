// Pure mapping from Prism v3 entities to the SDK model. The types describe only the fields read here;
// Prism returns many more, and any of them can be missing on an older Prism or a Prism Element.
import type { ConsoleKind, DiskDevice, HostDevice, NicDevice, NodeInfo, Snapshot, VmInfo, VmState } from '@vmm/sdk';
import type { Reference } from './client';

export interface VmDisk {
	uuid?: string;
	device_properties?: { device_type?: 'DISK' | 'CDROM' | 'VOLUME_GROUP' | string; disk_address?: { adapter_type?: string; device_index?: number } };
	disk_size_bytes?: number;
	disk_size_mib?: number;
	data_source_reference?: Reference;
	storage_config?: { storage_container_reference?: Reference };
	volume_group_reference?: Reference;
}

export interface VmNic {
	uuid?: string;
	mac_address?: string;
	model?: string;
	nic_type?: string;
	is_connected?: boolean;
	subnet_reference?: Reference;
	ip_endpoint_list?: Array<{ ip?: string; type?: string }>;
	floating_ip?: string;
}

export interface VmResources {
	num_sockets?: number;
	num_vcpus_per_socket?: number;
	num_threads_per_core?: number;
	memory_size_mib?: number;
	power_state?: 'ON' | 'OFF' | 'PAUSED' | 'UNKNOWN' | string;
	vga_console_enabled?: boolean;
	host_reference?: Reference;
	hypervisor_type?: string;
	machine_type?: string;
	disk_list?: VmDisk[];
	nic_list?: VmNic[];
	gpu_list?: Array<{ uuid?: string; vendor?: string; mode?: string; name?: string; device_id?: number; pci_address?: string }>;
	serial_port_list?: Array<{ index?: number; is_connected?: boolean }>;
	boot_config?: { boot_type?: string };
	guest_tools?: { nutanix_guest_tools?: { state?: string; guest_os_version?: string } };
	[key: string]: unknown;
}

export interface VmEntity {
	metadata: { uuid: string; kind?: string; spec_version?: number; creation_time?: string; [key: string]: unknown };
	spec?: { name: string; description?: string; resources: VmResources; cluster_reference?: Reference; [key: string]: unknown };
	status?: { name?: string; description?: string; state?: string; resources?: VmResources; cluster_reference?: Reference; [key: string]: unknown };
}

export interface ClusterEntity {
	metadata: { uuid: string };
	status?: {
		name?: string;
		state?: string;
		resources?: {
			config?: { service_list?: string[]; build?: { version?: string; full_version?: string }; is_available?: boolean; cluster_arch?: string };
			nodes?: { hypervisor_server_list?: Array<{ ip?: string; type?: string; version?: string }> };
			network?: { external_ip?: string };
		};
	};
}

export interface HostEntity {
	metadata: { uuid: string };
	status?: { name?: string; cluster_reference?: Reference; resources?: { num_cpu_cores?: number; memory_capacity_mib?: number; host_type?: string } };
}

export interface RecoveryPointEntity {
	metadata: { uuid: string; creation_time?: string };
	spec?: { name?: string };
	status?: { name?: string; state?: string; resources?: { parent_vm_reference?: Reference; creation_time?: string; recovery_point_type?: string } };
}

/** Prism Central lists itself among the clusters; it runs no user VMs, so it is not a node here. */
export function isPrismCentral(cluster: ClusterEntity): boolean {
	return cluster.status?.resources?.config?.service_list?.includes('PRISM_CENTRAL') ?? false;
}

/** A Prism Element cluster is a node in VM Manager: VMs are created on a cluster and move between its hosts. */
export function nodeInfo(cluster: ClusterEntity, hosts: HostEntity[]): NodeInfo {
	const resources = cluster.status?.resources;
	const own = hosts.filter((h) => h.status?.cluster_reference?.uuid === cluster.metadata.uuid);
	const hypervisors = [...new Set((resources?.nodes?.hypervisor_server_list ?? []).map((h) => [h.type, h.version].filter(Boolean).join(' ')).filter(Boolean))];
	const sum = (pick: (h: HostEntity) => number | undefined) => own.reduce<number | undefined>((total, h) => { const v = pick(h); return v === undefined ? total : (total ?? 0) + v; }, undefined);
	const version = resources?.config?.build?.version;
	const hostCount = own.length || resources?.nodes?.hypervisor_server_list?.length;
	return {
		id: cluster.metadata.uuid,
		name: cluster.status?.name ?? cluster.metadata.uuid,
		status: resources?.config?.is_available === false || cluster.status?.state === 'ERROR' ? 'offline' : cluster.status?.state && cluster.status.state !== 'COMPLETE' ? 'unknown' : 'online',
		cpus: sum((h) => h.status?.resources?.num_cpu_cores),
		memoryMB: sum((h) => h.status?.resources?.memory_capacity_mib),
		facts: [
			...(version ? [{ label: 'AOS', value: version }] : []),
			...(hypervisors.length ? [{ label: 'Hypervisor', value: hypervisors.join(', ') }] : []),
			...(hostCount ? [{ label: 'Hosts', value: String(hostCount) }] : []),
			...(resources?.network?.external_ip ? [{ label: 'Address', value: resources.network.external_ip }] : [])
		]
	};
}

/** The cluster a VM lives on: Prism Central reports it in the status, a VM being created only has it in the spec. */
export function vmCluster(vm: VmEntity): string | undefined {
	return vm.status?.cluster_reference?.uuid ?? vm.spec?.cluster_reference?.uuid;
}

/**
 * Power state. While Prism is still applying a spec change (`status.state` not `COMPLETE`) and the wanted
 * power state differs from the current one, the VM is on its way there.
 */
export function vmState(vm: VmEntity): VmState {
	const current = vm.status?.resources?.power_state;
	const wanted = vm.spec?.resources?.power_state;
	const applying = vm.status?.state !== undefined && vm.status.state !== 'COMPLETE';
	if (applying && wanted && current && wanted !== current) return wanted === 'ON' ? 'starting' : 'stopping';
	switch (current) {
		case 'ON': return 'running';
		case 'OFF': return 'stopped';
		case 'PAUSED': return 'paused';
		default: return 'unknown';
	}
}

const usable = (ip: string | undefined): ip is string => !!ip && !/^(127\.|::1$|fe80:|169\.254\.)/i.test(ip);

export function vmAddresses(resources: VmResources | undefined): string[] {
	return [...new Set((resources?.nic_list ?? []).flatMap((nic) => [...(nic.ip_endpoint_list ?? []).map((e) => e.ip), nic.floating_ip]).filter(usable))];
}

export function vmCpus(resources: VmResources | undefined): number | undefined {
	if (resources?.num_sockets === undefined) return undefined;
	return resources.num_sockets * (resources.num_vcpus_per_socket ?? 1);
}

/** The consoles Prism can proxy: the VGA display, unless it was turned off for the VM. */
export function vmConsoles(resources: VmResources | undefined): ConsoleKind[] {
	return resources?.vga_console_enabled === false ? [] : ['vnc'];
}

export function vmInfo(vm: VmEntity): VmInfo {
	const resources = vm.status?.resources ?? vm.spec?.resources;
	const macs = (resources?.nic_list ?? []).map((n) => n.mac_address?.toUpperCase()).filter((m): m is string => !!m);
	const addresses = vmAddresses(resources);
	const description = vm.status?.description ?? vm.spec?.description;
	return {
		id: vm.metadata.uuid,
		name: vm.status?.name ?? vm.spec?.name ?? vm.metadata.uuid,
		state: vmState(vm),
		cpus: vmCpus(resources),
		memoryMB: resources?.memory_size_mib,
		...(addresses.length ? { ipAddresses: addresses } : {}),
		...(macs.length ? { macAddresses: macs } : {}),
		...(description ? { description } : {}),
		...(resources?.guest_tools?.nutanix_guest_tools?.guest_os_version ? { os: resources.guest_tools.nutanix_guest_tools.guest_os_version } : {}),
		consoles: vmConsoles(resources)
	};
}

const adapterLabel = (adapter: string | undefined) => (adapter ?? 'disk').toUpperCase();

export function diskDevices(resources: VmResources | undefined): DiskDevice[] {
	return (resources?.disk_list ?? []).map((disk, index): DiskDevice => {
		const type = disk.device_properties?.device_type;
		const address = disk.device_properties?.disk_address;
		const cdrom = type === 'CDROM';
		const size = disk.disk_size_bytes ?? (disk.disk_size_mib !== undefined ? disk.disk_size_mib * 1024 * 1024 : undefined);
		return {
			id: disk.uuid ?? `${address?.adapter_type ?? 'disk'}.${address?.device_index ?? index}`,
			kind: cdrom ? 'cdrom' : 'disk',
			label: type === 'VOLUME_GROUP' ? `Volume group ${disk.volume_group_reference?.name ?? ''}`.trim() : `${adapterLabel(address?.adapter_type)} ${address?.device_index ?? index}`,
			path: disk.data_source_reference?.name ?? (cdrom ? undefined : disk.storage_config?.storage_container_reference?.name),
			sizeBytes: cdrom && !disk.data_source_reference ? undefined : size,
			bus: address?.adapter_type?.toLowerCase(),
			...(cdrom ? { removable: true } : {})
		};
	});
}

export function nicDevices(resources: VmResources | undefined): NicDevice[] {
	return (resources?.nic_list ?? []).map((nic, index): NicDevice => ({
		id: nic.uuid ?? `nic${index}`,
		label: `NIC ${index + 1}`,
		model: nic.model?.toLowerCase(),
		mac: nic.mac_address?.toUpperCase(),
		network: nic.subnet_reference?.name ?? nic.subnet_reference?.uuid,
		ipAddresses: [...new Set([...(nic.ip_endpoint_list ?? []).map((e) => e.ip), nic.floating_ip].filter(usable))],
		connected: nic.is_connected
	}));
}

export function hostDevices(resources: VmResources | undefined): HostDevice[] {
	const gpus = (resources?.gpu_list ?? []).map((gpu, index): HostDevice => ({
		id: gpu.uuid ?? `gpu${index}`,
		kind: 'pci',
		label: gpu.name ?? `${gpu.vendor ? `${gpu.vendor[0]}${gpu.vendor.slice(1).toLowerCase()} ` : ''}GPU`,
		address: gpu.pci_address,
		description: gpu.mode?.replace(/_/g, ' ').toLowerCase()
	}));
	const serial = (resources?.serial_port_list ?? []).map((port, index): HostDevice => ({ id: `serial${port.index ?? index}`, kind: 'other', label: `Serial port ${port.index ?? index}`, description: port.is_connected === false ? 'Disconnected' : undefined }));
	return [...gpus, ...serial];
}

export function recoveryPoint(entity: RecoveryPointEntity): Snapshot {
	const created = Date.parse(entity.status?.resources?.creation_time ?? entity.metadata.creation_time ?? '');
	return {
		id: entity.metadata.uuid,
		name: entity.status?.name ?? entity.spec?.name ?? entity.metadata.uuid,
		...(Number.isFinite(created) ? { createdAt: created } : {}),
		includesMemory: false
	};
}

/** Recovery points of one VM, oldest first. */
export function vmRecoveryPoints(all: RecoveryPointEntity[], vmId: string): Snapshot[] {
	return all
		.filter((rp) => rp.status?.resources?.parent_vm_reference?.uuid === vmId)
		.map(recoveryPoint)
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** Reads one attribute of a `/groups` reply as a number (the latest value). */
export function groupValue(reply: unknown, attribute: string): number | undefined {
	const entity = (reply as { group_results?: Array<{ entity_results?: Array<{ data?: Array<{ name?: string; values?: Array<{ values?: string[] }> }> }> }> } | undefined)?.group_results?.[0]?.entity_results?.[0];
	const raw = entity?.data?.find((d) => d.name === attribute)?.values?.[0]?.values?.[0];
	const value = raw === undefined || raw === '' ? NaN : Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}
