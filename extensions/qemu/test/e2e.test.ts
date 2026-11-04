/**
 * Runs the provider against a real QEMU. Opt-in: `VMM_E2E_QEMU=1 npx vitest run extensions/qemu/test/e2e.test.ts`
 * (needs QEMU on PATH; uses TCG and an empty UEFI VM, so it needs no guest OS).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QemuProvider } from '../src/QemuProvider';

describe.skipIf(!process.env.VMM_E2E_QEMU)('QEMU provider end to end', () => {
	let dir: string;
	let connection: Awaited<ReturnType<QemuProvider['connect']>>;
	let vmId: string;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-e2e-'));
		const log = { info() {}, warn() {}, error() {}, debug() {} };
		const provider = new QemuProvider({ defaultQemuPath: () => undefined });
		connection = await provider.connect(
			{ id: 'c', name: 'c', providerId: 'qemu', config: { accelerator: 'tcg', shutdownTimeout: 5 } },
			{},
			{ storagePath: dir, log }
		);
		const vm = await connection.createVm('local', { name: 'e2e', cpus: 1, memoryMB: 256, diskGB: 1, firmware: 'uefi', diskBus: 'sata', nic: 'none', serial: false });
		vmId = vm.id;
	}, 30_000);

	afterAll(async () => {
		await connection?.power('local', vmId, 'stop').catch(() => undefined);
		connection?.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const state = async () => (await connection.listVms('local')).find((v) => v.id === vmId)?.state;

	it('reports a timeout when the guest ignores the power button, then force-stops', async () => {
		await connection.power('local', vmId, 'start');
		expect(['running', 'starting']).toContain(await state());
		await new Promise((r) => setTimeout(r, 2000));

		const started = Date.now();
		await expect(connection.power('local', vmId, 'shutdown')).rejects.toMatchObject({ code: 'timeout' });
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(await state()).not.toBe('stopped'); // still up: the guest ignored ACPI

		await connection.power('local', vmId, 'stop');
		expect(await state()).toBe('stopped');
	}, 60_000);
});
