/**
 * The CIM reads give what the cmdlet reads give, for every VM on this host. Read-only: it changes nothing.
 * Opt-in: `VMM_E2E_HYPERV=1 npx vitest run extensions/hyperv/test/cim.e2e.test.ts` (Windows with Hyper-V).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { PowerShellSession } from '../src/PowerShellSession';
import * as scripts from '../src/scripts';

const enabled = process.platform === 'win32' && !!process.env.VMM_E2E_HYPERV;

type Row = Record<string, unknown>;

/** Machines of the other end-to-end test come and go while this runs in parallel. */
const stable = (rows: Row[]) => rows.filter((r) => !String(r.Name).startsWith('vmm-e2e-'));

/** Cmdlet ids are lower case; Ips order is whatever the guest reports. */
function normalise(row: Row): Row {
	const out = { ...row };
	if (Array.isArray(out.Ips)) out.Ips = [...(out.Ips as string[])].sort();
	return out;
}

/**
 * The cmdlet list (the reference) throws "a null-valued expression" when a VM is deleted while it runs, e.g. by the
 * other end-to-end test running in parallel; the CIM list ran 60 times through such churn without one. Try again.
 */
async function reference<T>(run: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt >= 5 || !/null-valued/.test((error as Error).message)) throw error;
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

async function timed<T>(run: () => Promise<T>, times = 5): Promise<{ result: T; ms: number }> {
	await run();
	const start = performance.now();
	let result!: T;
	for (let i = 0; i < times; i++) result = await run();
	return { result, ms: Math.round((performance.now() - start) / times) };
}

describe.skipIf(!enabled)('Hyper-V CIM reads match the cmdlets', () => {
	const session = new PowerShellSession('cim-parity');
	afterAll(() => session.dispose());
	const timings: string[] = [];
	afterAll(() => console.log(timings.join('\n')));

	it('lists the same machines with the same fields', async () => {
		const cmdlet = await timed(async () => stable(await reference(() => session.run<Row>(scripts.LIST_VMS, {}, 120_000))));
		const cim = await timed(async () => stable(await session.run<Row>(scripts.LIST_VMS_CIM, {}, 120_000)));
		timings.push(`list (${cmdlet.result.length} VMs): cmdlets ${cmdlet.ms} ms, CIM ${cim.ms} ms`);
		const byId = new Map(cim.result.map((r) => [r.Id, r]));
		expect([...byId.keys()].sort()).toEqual(cmdlet.result.map((r) => r.Id).sort());
		for (const row of cmdlet.result) {
			const other = byId.get(row.Id)!;
			// Uptime is read a moment apart.
			expect(Math.abs(Number(other.Uptime) - Number(row.Uptime))).toBeLessThanOrEqual(30);
			expect(normalise({ ...other, Uptime: 0 })).toEqual(normalise({ ...row, Uptime: 0 }));
		}
	}, 300_000);

	it('reads the same settings and checkpoints for every machine', async () => {
		const ids = stable(await session.run<Row>(scripts.LIST_VMS_CIM, {}, 120_000)).map((r) => String(r.Id));
		let cmdletMs = 0;
		let cimMs = 0;
		for (const id of ids) {
			const a = await timed(() => session.run<Row>(scripts.GET_CONFIG, { id }), 2);
			const b = await timed(() => session.run<Row>(scripts.GET_CONFIG_CIM, { id }), 2);
			cmdletMs += a.ms;
			cimMs += b.ms;
			expect({ id, ...b.result[0] }).toEqual({ id, ...a.result[0] });

			const [detailsA] = await session.run<Row>(scripts.VM_DETAILS, { id }, 60_000);
			const [detailsB] = await session.run<Row>(scripts.VM_DETAILS_CIM, { id }, 60_000);
			const nics = (d: Row) => ({ ...d, Nics: ([] as Row[]).concat((d.Nics as Row[] | Row | null) ?? []).map(normalise), Disks: ([] as Row[]).concat((d.Disks as Row[] | Row | null) ?? []) });
			expect({ id, ...nics(detailsB) }).toEqual({ id, ...nics(detailsA) });

			const snapA = await session.run<Row>(scripts.SNAPSHOT_LIST, { id }, 60_000);
			const snapB = await session.run<Row>(scripts.SNAPSHOT_LIST_CIM, { id }, 60_000);
			const sort = (rows: Row[]) => [...rows].sort((x, y) => String(x.Id).localeCompare(String(y.Id)));
			expect({ id, snapshots: sort(snapB) }).toEqual({ id, snapshots: sort(snapA) });
		}
		timings.push(`settings (per VM, ${ids.length} VMs): cmdlets ${Math.round(cmdletMs / ids.length)} ms, CIM ${Math.round(cimMs / ids.length)} ms`);
	}, 600_000);
});
