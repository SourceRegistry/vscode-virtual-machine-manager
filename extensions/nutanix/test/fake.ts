import { vi } from 'vitest';
import { NutanixClient } from '../src/client';
import type { VmEntity } from '../src/inventory';

export const PE = '00000000-0000-4000-8000-0000000000e1';
export const PC = '00000000-0000-4000-8000-0000000000c1';
export const VM1 = '11111111-1111-4111-8111-111111111111';
export const VM2 = '22222222-2222-4222-8222-222222222222';

export type Handler = (body: any, url: URL) => unknown;
export interface Call { method: string; path: string; body: any; headers: Record<string, string> }

/** A fetch that answers `METHOD /path` (relative to /api/nutanix/v3) from `routes`; unknown routes are 404. */
export function prism(routes: Record<string, Handler | unknown>) {
	const calls: Call[] = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/api\/nutanix\/v3/, '');
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, path, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
		const route = routes[`${method} ${path}`];
		if (route === undefined) return new Response(JSON.stringify({ message_list: [{ message: `no route ${method} ${path}` }] }), { status: 404 });
		const reply = typeof route === 'function' ? (route as Handler)(body, url) : route;
		if (reply instanceof Response) return reply;
		return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
	});
	const client = new NutanixClient('https://pc.test:9440', { username: 'admin', password: 'secret' }, fetch as unknown as typeof globalThis.fetch);
	return { fetch, calls, client };
}

export const list = <T>(entities: T[]) => ({ entities, metadata: { total_matches: entities.length } });
export const done = (extra: object = {}) => ({ status: 'SUCCEEDED', ...extra });

export function vm(uuid: string, overrides: { name?: string; power?: string; wanted?: string; state?: string; cluster?: string; resources?: object } = {}): VmEntity {
	const resources = {
		num_sockets: 2, num_vcpus_per_socket: 2, memory_size_mib: 4096, power_state: overrides.power ?? 'ON',
		nic_list: [{ uuid: 'nic-1', mac_address: '50:6b:8d:aa:bb:cc', model: 'VIRTIO', is_connected: true, subnet_reference: { kind: 'subnet', uuid: 's1', name: 'vlan0' }, ip_endpoint_list: [{ ip: '10.0.0.5' }, { ip: 'fe80::1' }] }],
		disk_list: [
			{ uuid: 'd1', device_properties: { device_type: 'DISK', disk_address: { adapter_type: 'SCSI', device_index: 0 } }, disk_size_bytes: 34359738368, storage_config: { storage_container_reference: { kind: 'storage_container', uuid: 'c', name: 'default' } } },
			{ uuid: 'd2', device_properties: { device_type: 'CDROM', disk_address: { adapter_type: 'IDE', device_index: 0 } } }
		],
		...overrides.resources
	};
	return {
		metadata: { kind: 'vm', uuid, spec_version: 3 },
		spec: { name: overrides.name ?? 'web', resources: { ...resources, power_state: overrides.wanted ?? overrides.power ?? 'ON' }, cluster_reference: { kind: 'cluster', uuid: overrides.cluster ?? PE } },
		status: { name: overrides.name ?? 'web', state: overrides.state ?? 'COMPLETE', resources, cluster_reference: { kind: 'cluster', uuid: overrides.cluster ?? PE } }
	};
}

export const clusters = [
	{ metadata: { uuid: PC }, status: { name: 'pc', state: 'COMPLETE', resources: { config: { service_list: ['PRISM_CENTRAL'] } } } },
	{ metadata: { uuid: PE }, status: { name: 'ahv-01', state: 'COMPLETE', resources: { config: { service_list: ['AOS'], build: { version: '6.10' } }, nodes: { hypervisor_server_list: [{ ip: '10.0.0.11', type: 'AHV', version: '20230302' }, { ip: '10.0.0.12', type: 'AHV', version: '20230302' }] }, network: { external_ip: '10.0.0.10' } } } }
];
export const hosts = [
	{ metadata: { uuid: 'h1' }, status: { name: 'h1', cluster_reference: { kind: 'cluster', uuid: PE }, resources: { num_cpu_cores: 32, memory_capacity_mib: 262144 } } },
	{ metadata: { uuid: 'h2' }, status: { name: 'h2', cluster_reference: { kind: 'cluster', uuid: PE }, resources: { num_cpu_cores: 32, memory_capacity_mib: 262144 } } }
];
