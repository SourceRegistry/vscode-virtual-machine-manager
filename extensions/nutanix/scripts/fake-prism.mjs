#!/usr/bin/env node
// A fake Prism Central for trying the Nutanix provider without a Nutanix cluster. It answers the v3
// endpoints the provider uses (shapes from the Prism Central v3.1 swagger), keeps its state in memory,
// runs every change as a task that takes a moment, and serves a tiny VNC display behind Prism's
// console proxy path. Not a Prism emulator: just enough behaviour to click through every flow.
//
//   node extensions/nutanix/scripts/fake-prism.mjs [--port 9440] [--host 127.0.0.1] [--user admin]
//        [--password nutanix/4u] [--api-key <key>] [--delay 1500]
//
// Then add a Nutanix cluster: URL https://localhost:9440, the user and password above (or the API key),
// and untick "Verify TLS certificate" (the certificate is a self-signed test certificate).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, '..', 'test', 'fixtures', name));

const json = (res, status, body, headers = {}) => {
	res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
	res.end(body === undefined ? '' : JSON.stringify(body));
};
const error = (res, status, message) => json(res, status, { api_version: '3.1', code: status, state: 'ERROR', message_list: [{ message, reason: status === 404 ? 'ENTITY_NOT_FOUND' : 'INVALID_REQUEST' }] });
const now = () => new Date().toISOString();
const ref = (kind, entity) => ({ kind, uuid: entity.metadata.uuid, name: entity.status?.name ?? entity.spec?.name });

/** The initial inventory: Prism Central, one AHV cluster with two hosts, subnets, images and a few VMs. */
export function seed() {
	const pc = { metadata: { kind: 'cluster', uuid: randomUUID() }, status: { name: 'prism-central', state: 'COMPLETE', resources: { config: { service_list: ['PRISM_CENTRAL'], build: { version: 'pc.2024.3' } }, network: { external_ip: '127.0.0.1' } } } };
	const pe = { metadata: { kind: 'cluster', uuid: randomUUID() }, status: { name: 'ce-cluster-1', state: 'COMPLETE', resources: { config: { service_list: ['AOS'], build: { version: '6.10.1', full_version: 'el8.5-release-fraser-6.10.1' }, is_available: true }, nodes: { hypervisor_server_list: [{ ip: '10.42.0.11', type: 'AHV', version: '10.0.1' }, { ip: '10.42.0.12', type: 'AHV', version: '10.0.1' }] }, network: { external_ip: '10.42.0.10' } } } };
	const host = (name, ip) => ({ metadata: { kind: 'host', uuid: randomUUID() }, status: { name, state: 'COMPLETE', cluster_reference: ref('cluster', pe), resources: { num_cpu_cores: 16, num_cpu_sockets: 1, memory_capacity_mib: 131072, hypervisor: { ip, hypervisor_full_name: 'AHV 10.0.1' } } } });
	const subnet = (name, vlan) => ({ metadata: { kind: 'subnet', uuid: randomUUID() }, spec: { name, cluster_reference: ref('cluster', pe), resources: { subnet_type: 'VLAN', vlan_id: vlan } }, status: { name, state: 'COMPLETE', cluster_reference: ref('cluster', pe), resources: { subnet_type: 'VLAN', vlan_id: vlan } } });
	const image = (name, type, size) => ({ metadata: { kind: 'image', uuid: randomUUID() }, spec: { name, resources: { image_type: type } }, status: { name, state: 'COMPLETE', resources: { image_type: type, size_bytes: size, current_cluster_reference_list: [{ kind: 'cluster', uuid: pe.metadata.uuid }] } } });
	const state = {
		clusters: [pc, pe],
		hosts: [host('ahv-node-a', '10.42.0.11'), host('ahv-node-b', '10.42.0.12')],
		subnets: [subnet('vm-network', 0), subnet('lab-vlan-42', 42)],
		images: [image('debian-13-genericcloud-amd64', 'DISK_IMAGE', 3 * 1024 ** 3), image('ubuntu-24.04-server-cloudimg', 'DISK_IMAGE', 4 * 1024 ** 3), image('ubuntu-24.04-live-server.iso', 'ISO_IMAGE', 2.6 * 1024 ** 3)],
		vms: [],
		recoveryPoints: [],
		tasks: new Map(),
		nextIp: 20
	};
	for (const [name, power, sockets, memory] of [['web-01', 'ON', 2, 4096], ['db-01', 'ON', 4, 16384], ['build-runner', 'OFF', 8, 8192], ['win-test', 'OFF', 2, 8192]]) {
		createVm(state, { name, description: name === 'db-01' ? 'PostgreSQL 17' : undefined, cluster_reference: ref('cluster', pe), resources: { num_sockets: sockets, num_vcpus_per_socket: 1, memory_size_mib: memory, power_state: power, nic_list: [{ subnet_reference: { kind: 'subnet', uuid: state.subnets[0].metadata.uuid } }], disk_list: [{ device_properties: { device_type: 'DISK', disk_address: { adapter_type: 'SCSI', device_index: 0 } }, disk_size_mib: 40960 }, { device_properties: { device_type: 'CDROM', disk_address: { adapter_type: 'IDE', device_index: 0 } } }] } });
	}
	return state;
}

const clone = (value) => structuredClone(value);
const mac = () => `50:6b:8d:${[0, 0, 0].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':')}`;

/** Fills in what Prism adds to a spec (uuids, MACs, sizes, names of references) and returns the status resources. */
function realize(state, spec, previous) {
	const resources = clone(spec.resources);
	resources.nic_list = (resources.nic_list ?? []).map((nic, index) => {
		const old = previous?.nic_list?.[index];
		const subnet = state.subnets.find((s) => s.metadata.uuid === nic.subnet_reference?.uuid);
		return { uuid: nic.uuid ?? old?.uuid ?? randomUUID(), model: 'VIRTIO', nic_type: 'NORMAL_NIC', is_connected: true, ...nic, mac_address: nic.mac_address ?? old?.mac_address ?? mac(), subnet_reference: subnet ? ref('subnet', subnet) : nic.subnet_reference, ip_endpoint_list: old?.ip_endpoint_list ?? [{ ip: `10.42.1.${state.nextIp++}`, type: 'LEARNED' }] };
	});
	resources.disk_list = (resources.disk_list ?? []).map((disk, index) => {
		const old = previous?.disk_list?.[index];
		const image = state.images.find((i) => i.metadata.uuid === disk.data_source_reference?.uuid);
		const size = disk.disk_size_mib ?? (image && disk.device_properties?.device_type !== 'CDROM' ? Math.ceil(image.status.resources.size_bytes / 1048576) : undefined) ?? old?.disk_size_mib;
		return { uuid: disk.uuid ?? old?.uuid ?? randomUUID(), ...disk, ...(image ? { data_source_reference: ref('image', image) } : {}), ...(size !== undefined && disk.device_properties?.device_type !== 'CDROM' ? { disk_size_mib: size, disk_size_bytes: size * 1048576, storage_config: { storage_container_reference: { kind: 'storage_container', uuid: 'default-container', name: 'default-container' } } } : {}) };
	});
	resources.vga_console_enabled = resources.vga_console_enabled ?? true;
	resources.hypervisor_type = 'AHV';
	resources.host_reference = resources.power_state === 'ON' ? ref('host', state.hosts[state.vms.length % state.hosts.length]) : undefined;
	return resources;
}

function createVm(state, spec) {
	const uuid = randomUUID();
	const resources = realize(state, spec);
	const vm = {
		metadata: { kind: 'vm', uuid, spec_version: 0, creation_time: now(), last_update_time: now(), categories: {} },
		spec: { ...clone(spec), resources: { ...clone(spec.resources), nic_list: resources.nic_list.map(({ ip_endpoint_list, ...nic }) => nic), disk_list: resources.disk_list } },
		status: { name: spec.name, description: spec.description, state: 'COMPLETE', cluster_reference: spec.cluster_reference, resources }
	};
	state.vms.push(vm);
	return vm;
}

/** A task that runs for `delay` ms, then applies `effect` (which may throw to fail it). */
function task(state, delay, operation, entities, effect) {
	const uuid = randomUUID();
	const t = { uuid, status: 'QUEUED', operation_type: operation, percentage_complete: 0, creation_time: now(), entity_reference_list: entities, progress_message: operation };
	state.tasks.set(uuid, t);
	setTimeout(() => { t.status = 'RUNNING'; t.percentage_complete = 50; }, Math.min(100, delay / 4)).unref?.();
	setTimeout(() => {
		try {
			const more = effect?.();
			if (more) t.entity_reference_list = [...t.entity_reference_list, ...more];
			t.status = 'SUCCEEDED';
		} catch (e) {
			t.status = 'FAILED';
			t.error_code = 'FAKE_PRISM_ERROR';
			t.error_detail = e.message;
		}
		t.percentage_complete = 100;
		t.completion_time = now();
	}, delay).unref?.();
	return uuid;
}

const intent = (vm, taskUuid) => ({ api_version: '3.1', metadata: vm.metadata, spec: vm.spec, status: { ...vm.status, ...(taskUuid ? { state: 'PENDING', execution_context: { task_uuid: taskUuid } } : {}) } });

/** Sets the power state at the end of a task, as Prism does after the hypervisor acted. */
function setPower(state, vm, power) {
	vm.status.resources.power_state = power;
	vm.status.resources.host_reference = power === 'ON' ? ref('host', state.hosts[0]) : undefined;
	vm.status.state = 'COMPLETE';
	vm.metadata.last_update_time = now();
}

function page(list, body) {
	const offset = Number(body?.offset ?? 0);
	const length = Math.min(Number(body?.length ?? 20), 500);
	return { api_version: '3.1', metadata: { kind: body?.kind, offset, length, total_matches: list.length }, entities: list.slice(offset, offset + length) };
}

/** Starts the fake. Resolves with its URL, its state and `close()`. */
export async function startFakePrism({ port = 9440, host = '127.0.0.1', user = 'admin', password = 'nutanix/4u', apiKey, delay = 1500, log = console.log, key = fixture('fake-prism-key.pem'), cert = fixture('fake-prism-cert.pem') } = {}) {
	const state = seed();
	const sessions = new Set();
	const authorized = (req) => {
		const session = /NTNX_IGW_SESSION=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
		if (session && sessions.has(session)) return true;
		if (apiKey && req.headers['x-ntnx-api-key'] === apiKey) return true;
		const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
		return !!basic && Buffer.from(basic, 'base64').toString('utf8') === `${user}:${password}`;
	};
	const vmOf = (uuid) => state.vms.find((v) => v.metadata.uuid === uuid);

	const server = createServer({ key, cert }, async (req, res) => {
		const url = new URL(req.url ?? '/', 'https://fake');
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		let body;
		try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch { return error(res, 400, 'Invalid JSON'); }
		log?.(`${req.method} ${url.pathname}`);
		if (!url.pathname.startsWith('/api/nutanix/v3/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Fake Prism Central</h1><p>Only the v3 API is served here.</p>'); return; }
		if (!authorized(req)) return json(res, 401, { api_version: '3.1', code: 401, message_list: [{ message: 'Authentication required.', reason: 'AUTHENTICATION_REQUIRED' }], state: 'ERROR' });
		const session = randomUUID();
		sessions.add(session);
		const cookie = { 'Set-Cookie': `NTNX_IGW_SESSION=${session}; Path=/; Secure; HttpOnly` };
		const reply = (status, value) => json(res, status, value, cookie);
		const route = `${req.method} ${url.pathname.slice('/api/nutanix/v3'.length)}`;
		let m;
		try {
			if (route === 'GET /users/me') return reply(200, { metadata: { kind: 'user', uuid: '00000000-0000-4000-8000-000000000001' }, status: { name: user, state: 'COMPLETE' } });
			if (route === 'GET /versions') return reply(200, { versions: ['3.1'] });
			if (route === 'POST /clusters/list') return reply(200, page(state.clusters, body));
			if (route === 'POST /hosts/list') return reply(200, page(state.hosts, body));
			if (route === 'POST /subnets/list') return reply(200, page(state.subnets, body));
			if (route === 'POST /images/list') return reply(200, page(state.images, body));
			if (route === 'POST /vms/list') return reply(200, page(state.vms.map((vm) => intent(vm)), body));
			if (route === 'POST /vm_recovery_points/list') return reply(200, page(state.recoveryPoints, body));
			if ((m = /^GET \/images\/([\w-]+)$/.exec(route))) { const image = state.images.find((i) => i.metadata.uuid === m[1]); return image ? reply(200, image) : error(res, 404, 'Image not found'); }
			if ((m = /^GET \/tasks\/([\w-]+)$/.exec(route))) { const t = state.tasks.get(m[1]); return t ? reply(200, t) : error(res, 404, 'Task not found'); }
			if (route === 'POST /groups') {
				const id = body?.entity_ids?.[0];
				const vm = vmOf(id);
				const on = vm?.status.resources.power_state === 'ON';
				const value = (base) => [{ values: [String(on ? Math.round(base * (0.6 + Math.random() * 0.8)) : 0)], time: Date.now() * 1000 }];
				const data = (body?.group_member_attributes ?? []).map(({ attribute }) => ({ name: attribute, values: attribute === 'hypervisor_cpu_usage_ppm' ? value(180_000) : attribute === 'memory_usage_ppm' ? value(420_000) : attribute === 'hypervisor_memory_usage_ppm' ? value(650_000) : [] }));
				return reply(200, { entity_type: body?.entity_type, total_entity_count: vm ? 1 : 0, filtered_entity_count: vm ? 1 : 0, group_results: vm ? [{ entity_results: [{ entity_id: id, data }] }] : [] });
			}
			if (route === 'POST /vms') {
				if (!body?.spec?.name || !body.spec.resources) return error(res, 422, 'spec.name and spec.resources are required');
				const wanted = body.spec.resources.power_state;
				const vm = createVm(state, { ...body.spec, resources: { ...body.spec.resources, power_state: 'OFF' } });
				vm.spec.resources.power_state = wanted ?? 'OFF';
				vm.status.state = 'PENDING';
				const t = task(state, delay, 'VmCreate', [ref('vm', vm)], () => setPower(state, vm, wanted === 'ON' ? 'ON' : 'OFF'));
				return reply(202, intent(vm, t));
			}
			if ((m = /^(GET|PUT|DELETE) \/vms\/([\w-]+)$/.exec(route))) {
				const vm = vmOf(m[2]);
				if (!vm) return error(res, 404, `VM ${m[2]} not found`);
				if (m[1] === 'GET') return reply(200, intent(vm));
				if (m[1] === 'DELETE') {
					vm.status.state = 'DELETE_PENDING';
					const t = task(state, delay, 'VmDelete', [ref('vm', vm)], () => { state.vms.splice(state.vms.indexOf(vm), 1); state.recoveryPoints = state.recoveryPoints.filter((rp) => rp.status.resources.parent_vm_reference.uuid !== vm.metadata.uuid); });
					return reply(202, intent(vm, t));
				}
				if (body?.metadata?.spec_version !== vm.metadata.spec_version) return json(res, 409, { api_version: '3.1', code: 409, state: 'ERROR', message_list: [{ reason: 'CONCURRENT_REQUESTS_NOT_ALLOWED', message: `spec_version ${body?.metadata?.spec_version} is stale; current is ${vm.metadata.spec_version}` }] }, cookie);
				const spec = body.spec;
				const was = vm.status.resources;
				if (spec.resources.memory_size_mib < was.memory_size_mib && was.power_state === 'ON') return error(res, 422, 'Memory cannot be reduced while the VM is powered on.');
				vm.metadata.spec_version++;
				vm.spec = clone(spec);
				const power = spec.resources.power_state ?? was.power_state;
				const mechanism = spec.resources.power_state_mechanism?.mechanism;
				delete vm.spec.resources.power_state_mechanism;
				vm.status.state = 'PENDING';
				const t = task(state, power !== was.power_state ? delay * 1.5 : delay, 'VmUpdate', [ref('vm', vm)], () => {
					vm.status.name = spec.name;
					vm.status.description = spec.description;
					vm.status.resources = { ...realize(state, spec, was), power_state: was.power_state };
					if (power !== was.power_state && mechanism === 'ACPI' && /win/i.test(spec.name)) { vm.spec.resources.power_state = was.power_state; vm.status.state = 'COMPLETE'; throw new Error('The guest did not respond to the ACPI shutdown request.'); }
					setPower(state, vm, power);
				});
				return reply(202, intent(vm, t));
			}
			if ((m = /^POST \/vms\/([\w-]+)\/(acpi_shutdown|acpi_reboot|reset|power_cycle|guest_shutdown|guest_reboot|snapshot|revert|clone)$/.exec(route))) {
				const vm = vmOf(m[1]);
				if (!vm) return error(res, 404, `VM ${m[1]} not found`);
				const action = m[2];
				const on = vm.status.resources.power_state === 'ON';
				if (['acpi_shutdown', 'acpi_reboot', 'reset', 'power_cycle', 'guest_shutdown', 'guest_reboot'].includes(action)) {
					if (!on) return error(res, 422, `The VM is powered off: ${action} needs a running VM.`);
					const t = task(state, delay, action, [ref('vm', vm)], () => {
						// A guest without ACPI handling ignores the request: try a VM whose name has "win" in it.
						if (action === 'acpi_shutdown' && /win/i.test(vm.status.name)) throw new Error('The guest did not respond to the ACPI shutdown request.');
						if (action === 'acpi_shutdown' || action === 'guest_shutdown') { vm.spec.resources.power_state = 'OFF'; setPower(state, vm, 'OFF'); }
					});
					return reply(202, { task_uuid: t });
				}
				if (action === 'snapshot') {
					const rp = { metadata: { kind: 'vm_recovery_point', uuid: randomUUID(), creation_time: now() }, spec: { name: body?.name }, status: { name: body?.name ?? `rp-${Date.now()}`, state: 'COMPLETE', resources: { parent_vm_reference: ref('vm', vm), creation_time: now(), recovery_point_type: body?.recovery_point_type ?? 'CRASH_CONSISTENT', vm_spec: clone(vm.spec) } } };
					const t = task(state, delay, 'VmSnapshot', [ref('vm', vm)], () => { state.recoveryPoints.push(rp); return [ref('vm_recovery_point', rp)]; });
					return reply(202, { task_uuid: t });
				}
				if (action === 'revert') {
					const rp = state.recoveryPoints.find((r) => r.metadata.uuid === body?.vm_recovery_point_uuid);
					if (!rp) return error(res, 404, 'Recovery point not found');
					const t = task(state, delay, 'VmRevert', [ref('vm', vm)], () => {
						if (vm.status.resources.power_state === 'ON') throw new Error('Power off the VM before reverting it.');
						const spec = clone(rp.status.resources.vm_spec);
						vm.spec = { ...spec, resources: { ...spec.resources, power_state: 'OFF' } };
						vm.status.name = spec.name;
						vm.status.resources = { ...realize(state, vm.spec, vm.status.resources), power_state: 'OFF' };
						vm.metadata.spec_version++;
					});
					return reply(202, { task_uuid: t });
				}
				const name = body?.override_spec?.name ?? `${vm.status.name}-clone`;
				const t = task(state, delay * 2, 'VmClone', [ref('vm', vm)], () => {
					const spec = clone(vm.spec);
					spec.name = name;
					spec.resources.power_state = 'OFF';
					spec.resources.nic_list = spec.resources.nic_list.map(({ uuid, mac_address, ...nic }) => nic);
					spec.resources.disk_list = spec.resources.disk_list.map(({ uuid, ...disk }) => disk);
					return [ref('vm', createVm(state, spec))];
				});
				return reply(202, { task_uuid: t });
			}
			if ((m = /^DELETE \/vm_recovery_points\/([\w-]+)$/.exec(route))) {
				const rp = state.recoveryPoints.find((r) => r.metadata.uuid === m[1]);
				if (!rp) return error(res, 404, 'Recovery point not found');
				const t = task(state, delay, 'VmRecoveryPointDelete', [ref('vm_recovery_point', rp)], () => { state.recoveryPoints.splice(state.recoveryPoints.indexOf(rp), 1); });
				return reply(202, { status: { state: 'DELETE_PENDING', execution_context: { task_uuid: t } } });
			}
			return error(res, 404, `The fake Prism does not serve ${route}`);
		} catch (e) {
			return error(res, 500, String(e?.stack ?? e));
		}
	});

	// Prism's VNC proxy: a websocket carrying RFB. This one draws a small animated test picture.
	const wss = new WebSocketServer({ noServer: true });
	server.on('upgrade', (req, socket, head) => {
		const match = /^\/vnc\/vm\/([\w-]+)\/proxy/.exec(req.url ?? '');
		const vm = match && vmOf(match[1]);
		if (!authorized(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
		if (!vm) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return; }
		wss.handleUpgrade(req, socket, head, (ws) => rfbSession(ws, vm, log));
	});

	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
	const address = server.address();
	const url = `https://${host === '127.0.0.1' ? 'localhost' : host}:${address.port}`;
	return {
		url, state,
		close: () => new Promise((resolve) => { for (const client of wss.clients) client.terminate(); server.closeAllConnections?.(); server.close(() => resolve()); })
	};
}

/** A minimal RFB 3.8 server: no authentication, raw encoding, a picture that changes with the VM's power state. */
function rfbSession(ws, vm, log) {
	const width = 640, height = 400;
	let buffer = Buffer.alloc(0);
	let phase = 'version';
	let format = { bpp: 32, bigEndian: false, red: 16, green: 8, blue: 0 };
	let timer;
	let frame = 0;
	const send = (data) => { if (ws.readyState === ws.OPEN) ws.send(data); };
	const hue = [...String(vm.status.name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
	const rgb = (h, s, l) => {
		const k = (n) => (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
		return [f(0), f(8), f(4)];
	};
	const update = () => {
		const on = vm.status.resources.power_state === 'ON';
		const pixels = Buffer.alloc(width * height * 4);
		const background = on ? rgb(hue, 0.45, 0.22) : [24, 24, 24];
		const bar = on ? rgb((hue + 180) % 360, 0.7, 0.6) : [80, 80, 80];
		const x0 = (frame * 12) % width;
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			const inBar = y > 180 && y < 220 && (x - x0 + width) % width < 120;
			const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
			const [r, g, b] = border ? [200, 200, 200] : inBar ? bar : background;
			const value = (r << format.red) | (g << format.green) | (b << format.blue);
			if (format.bigEndian) pixels.writeUInt32BE(value >>> 0, (y * width + x) * 4); else pixels.writeUInt32LE(value >>> 0, (y * width + x) * 4);
		}
		frame++;
		const header = Buffer.alloc(16);
		header.writeUInt8(0, 0); header.writeUInt16BE(1, 2);
		header.writeUInt16BE(0, 4); header.writeUInt16BE(0, 6); header.writeUInt16BE(width, 8); header.writeUInt16BE(height, 10); header.writeInt32BE(0, 12);
		send(Buffer.concat([header, pixels]));
	};
	send(Buffer.from('RFB 003.008\n'));
	ws.on('message', (data) => {
		buffer = Buffer.concat([buffer, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
		for (;;) {
			if (phase === 'version') { if (buffer.length < 12) return; buffer = buffer.subarray(12); send(Buffer.from([1, 1])); phase = 'security'; continue; }
			if (phase === 'security') { if (buffer.length < 1) return; buffer = buffer.subarray(1); send(Buffer.alloc(4)); phase = 'init'; continue; }
			if (phase === 'init') {
				if (buffer.length < 1) return;
				buffer = buffer.subarray(1);
				const name = Buffer.from(`${vm.status.name} (fake Prism)`);
				const init = Buffer.alloc(24);
				init.writeUInt16BE(width, 0); init.writeUInt16BE(height, 2);
				Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
				init.writeUInt32BE(name.length, 20);
				send(Buffer.concat([init, name]));
				phase = 'normal';
				continue;
			}
			if (buffer.length < 1) return;
			const type = buffer[0];
			const need = type === 0 ? 20 : type === 2 ? (buffer.length >= 4 ? 4 + 4 * buffer.readUInt16BE(2) : Infinity) : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : type === 6 ? (buffer.length >= 8 ? 8 + buffer.readUInt32BE(4) : Infinity) : -1;
			if (need === -1) { log?.(`RFB: unknown client message ${type}`); ws.close(); return; }
			if (buffer.length < need) return;
			const message = buffer.subarray(0, need);
			buffer = buffer.subarray(need);
			if (type === 0) format = { bpp: message[4], bigEndian: message[6] === 1, red: message[14], green: message[15], blue: message[16] };
			if (type === 3) {
				const incremental = message[1] === 1;
				clearTimeout(timer);
				if (incremental) timer = setTimeout(update, 200); else update();
			}
		}
	});
	ws.on('close', () => clearTimeout(timer));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
	const options = { port: Number(arg('port', 9440)), host: arg('host', '127.0.0.1'), user: arg('user', 'admin'), password: arg('password', 'nutanix/4u'), apiKey: arg('api-key'), delay: Number(arg('delay', 1500)) };
	const fake = await startFakePrism({ ...options, log: (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`) });
	console.log(`Fake Prism Central on ${fake.url}`);
	console.log(`  user ${options.user}, password ${options.password}${options.apiKey ? `, API key ${options.apiKey}` : ''}`);
	console.log('  untick "Verify TLS certificate" (self-signed test certificate)');
	console.log('  a VM with "win" in its name ignores ACPI shutdown, to try the Power Off prompt');
	process.on('SIGINT', () => fake.close().then(() => process.exit(0)));
}
