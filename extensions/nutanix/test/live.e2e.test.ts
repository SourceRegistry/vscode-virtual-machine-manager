// Read-only check against a real Prism Central. Opt-in, never changes anything:
//   VMM_E2E_NUTANIX=1 VMM_E2E_NUTANIX_URL=https://pc:9440 VMM_E2E_NUTANIX_API_KEY=… npx vitest run extensions/nutanix/test/live.e2e.test.ts
// or VMM_E2E_NUTANIX_USER / VMM_E2E_NUTANIX_PASSWORD instead of the API key; VMM_E2E_NUTANIX_INSECURE=1 for a self-signed certificate.
// Behind a web sign-in (Nutanix Test Drive): VMM_E2E_NUTANIX_COOKIE='name=value; …' from the signed-in browser, with or
// without Prism credentials.
import { Agent } from 'node:https';
import { afterAll, describe, expect, it } from 'vitest';
import { NutanixClient, nutanixFetch, type Credentials } from '../src/client';
import { NutanixConnection } from '../src/NutanixProvider';

const env = process.env;
const enabled = env.VMM_E2E_NUTANIX === '1' && !!env.VMM_E2E_NUTANIX_URL;

describe.skipIf(!enabled)('Nutanix against a live Prism (read-only)', () => {
	let connection: NutanixConnection | undefined;
	const verifyTls = env.VMM_E2E_NUTANIX_INSECURE !== '1';
	const agent = new Agent({ rejectUnauthorized: verifyTls, keepAlive: true });
	const cookie = env.VMM_E2E_NUTANIX_COOKIE;
	const credentials: Credentials = env.VMM_E2E_NUTANIX_API_KEY
		? { apiKey: env.VMM_E2E_NUTANIX_API_KEY, cookie }
		: env.VMM_E2E_NUTANIX_USER ? { username: env.VMM_E2E_NUTANIX_USER, password: env.VMM_E2E_NUTANIX_PASSWORD ?? '', cookie } : { none: true, cookie };
	afterAll(() => { connection?.dispose(); agent.destroy(); });

	it('signs in and lists the clusters', { timeout: 60_000 }, async () => {
		const origin = new URL(env.VMM_E2E_NUTANIX_URL!).origin;
		console.log('signing in to', origin, 'with', Object.keys(credentials).filter((k) => (credentials as Record<string, unknown>)[k] !== undefined).join(' + '));
		connection = new NutanixConnection(new NutanixClient(origin, credentials, nutanixFetch(agent, verifyTls)), verifyTls, async () => undefined);
		const nodes = await connection.listNodes();
		console.log('nodes', nodes.map((n) => ({ name: n.name, status: n.status, cpus: n.cpus, memoryMB: n.memoryMB, facts: n.facts })));
		expect(nodes.length).toBeGreaterThan(0);
	});

	it('lists VMs and reads one VM in every way the extension does', { timeout: 120_000 }, async () => {
		const nodes = await connection!.listNodes();
		const all = (await Promise.all(nodes.map(async (n) => (await connection!.listVms(n.id)).map((vm) => ({ node: n.id, vm }))))).flat();
		console.log('vms', all.length, all.slice(0, 10).map(({ vm }) => ({ name: vm.name, state: vm.state, cpus: vm.cpus, memoryMB: vm.memoryMB, ips: vm.ipAddresses })));
		const pick = all.find(({ vm }) => vm.state === 'running') ?? all[0];
		if (!pick) return;
		const details = await connection!.getVmDetails(pick.node, pick.vm.id);
		console.log('details of', pick.vm.name, JSON.stringify(details, null, 1));
		expect(details.disks.length + details.nics.length).toBeGreaterThan(0);
		console.log('config', (await connection!.getVmConfig(pick.node, pick.vm.id)).values);
		console.log('stats', await connection!.getVmStats(pick.node, pick.vm.id));
		console.log('recovery points', await connection!.listSnapshots(pick.node, pick.vm.id).catch((error: Error) => `failed: ${error.message}`));
		const schema = await connection!.getCreateSchema(pick.node);
		console.log('create choices', schema.filter((f) => f.options).map((f) => ({ key: f.key, options: f.options!.map((o) => o.label) })));
	});
});
