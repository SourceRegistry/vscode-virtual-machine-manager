/**
 * A full guest OS install from an ISO, the way a user does it: create a machine with the installer in its CD/DVD
 * drive, install to the disk over the serial console, eject the ISO, and boot the installed system. Opt-in, slow
 * (minutes), needs internet access in the guest (the installer downloads packages) and Alpine's `virt` ISO of the
 * host's architecture:
 *
 *   VMM_E2E_INSTALL_ISO=/path/alpine-virt-3.24.4-aarch64.iso npx vitest run extensions/qemu/test/install.e2e.test.ts
 *
 * The ISO is only read. On Apple Silicon this runs natively (HVF); elsewhere it runs as fast as the accelerator allows.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConsoleStream } from '@vmm/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QemuProvider } from '../src/QemuProvider';

const iso = process.env.VMM_E2E_INSTALL_ISO;
const arch = iso && /aarch64|arm64/i.test(path.basename(iso)) ? 'aarch64' : 'x86_64';

// setup-alpine answers: a `sys` install to the first VirtIO disk, DHCP, the first mirror, nothing else.
const ANSWERS = [
	'KEYMAPOPTS=none',
	'HOSTNAMEOPTS=vmm-install',
	'INTERFACESOPTS="auto lo',
	'iface lo inet loopback',
	'auto eth0',
	'iface eth0 inet dhcp"',
	'DNSOPTS=none',
	'TIMEZONEOPTS=none',
	'PROXYOPTS=none',
	'APKREPOSOPTS="-1"',
	'USEROPTS=none',
	'SSHDOPTS=none',
	'NTPOPTS=none',
	'DISKOPTS="-m sys /dev/vda"'
];

/** A serial console with a transcript to wait on. */
class Serial {
	private text = '';
	private mark = 0;
	constructor(private readonly console: ConsoleStream) {
		console.stream.setEncoding('utf8');
		console.stream.on('data', (chunk: string) => (this.text += chunk));
	}

	/** Waits for `pattern` in what arrived since the last match. */
	async waitFor(pattern: RegExp, timeoutMs: number): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const rest = this.text.slice(this.mark);
			const match = pattern.exec(rest);
			if (match) {
				this.mark += match.index + match[0].length;
				return rest.slice(0, match.index + match[0].length);
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`Timed out waiting for ${pattern}. Last output:\n${this.text.slice(-1500)}`);
	}

	/** Types a line, slowly enough for a getty that echoes. */
	async line(text: string): Promise<void> {
		for (const char of `${text}\r`) {
			this.console.stream.write(char);
			await new Promise((r) => setTimeout(r, 2));
		}
	}

	/** Runs a shell command and waits for its marker, returning the output before it. */
	async run(command: string, timeoutMs: number): Promise<string> {
		const marker = `DONE-${Math.random().toString(36).slice(2, 8)}`;
		await this.line(`${command}; echo ${marker.slice(0, 4)}''${marker.slice(4)}=$?`);
		const output = await this.waitFor(new RegExp(`${marker}=(\\d+)`), timeoutMs);
		const status = new RegExp(`${marker}=(\\d+)`).exec(output)![1];
		if (status !== '0') throw new Error(`"${command}" failed (${status}):\n${output.slice(-1500)}`);
		return output;
	}

	dispose(): void {
		this.console.dispose();
	}
}

describe.skipIf(!iso)(`Install ${iso ? path.basename(iso) : 'an OS'} from its ISO`, () => {
	let dir: string;
	let connection: Awaited<ReturnType<QemuProvider['connect']>>;
	let vmId: string;
	let serial: Serial | undefined;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-install-'));
		const log = { info() {}, warn() {}, error() {}, debug() {} };
		connection = await new QemuProvider({ defaultQemuPath: () => undefined }).connect({ id: 'c', name: 'c', providerId: 'qemu', config: { shutdownTimeout: 60 } }, {}, { storagePath: dir, log });
	}, 60_000);

	afterAll(async () => {
		serial?.dispose();
		if (vmId) await connection?.power('local', vmId, 'stop').catch(() => undefined);
		connection?.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const state = async () => (await connection.listVms('local')).find((v) => v.id === vmId)?.state;
	const waitForState = async (wanted: string, timeoutMs: number) => {
		const deadline = Date.now() + timeoutMs;
		while ((await state()) !== wanted) {
			if (Date.now() > deadline) throw new Error(`Still ${await state()}, not ${wanted}`);
			await new Promise((r) => setTimeout(r, 500));
		}
	};
	const login = async () => {
		await serial!.waitFor(/login: $/m, 5 * 60_000);
		await serial!.line('root');
		// BusyBox ash follows its prompt with a cursor position query (ESC [6n).
		await serial!.waitFor(/# (?:\x1b\[6n)?$/m, 60_000);
	};

	it('creates the machine with the installer in its CD/DVD drive', async () => {
		const vm = await connection.createVm('local', { name: 'install', arch, cpus: 2, memoryMB: 1024, diskGB: 2, cdrom: iso, firmware: 'uefi', diskBus: 'virtio', nic: 'virtio', serial: true });
		vmId = vm.id;
		expect((await connection.listVms('local')).find((v) => v.id === vmId)).toMatchObject({ state: 'stopped', mediaInserted: true });
	});

	it('boots the installer and installs to the disk', async () => {
		await connection.power('local', vmId, 'start');
		serial = new Serial(await connection.openConsole('local', vmId, 'serial'));
		await login();
		await serial.run(`printf '%s\\n' ${ANSWERS.map((a) => `'${a}'`).join(' ')} > /tmp/answers`, 30_000);
		await serial.run('ERASE_DISKS=/dev/vda setup-alpine -e -f /tmp/answers', 10 * 60_000);
		await serial.line('poweroff');
		await waitForState('stopped', 2 * 60_000);
		serial.dispose();
		serial = undefined;
	}, 15 * 60_000);

	it('ejects the installer and boots the installed system from its disk', async () => {
		const cdrom = (await connection.getVmDetails!('local', vmId)).disks.find((d) => d.kind === 'cdrom')!;
		await connection.ejectMedia!('local', vmId, cdrom.id);
		expect((await connection.listVms('local')).find((v) => v.id === vmId)?.mediaInserted).toBeFalsy();

		await connection.power('local', vmId, 'start');
		serial = new Serial(await connection.openConsole('local', vmId, 'serial'));
		await login();
		const output = await serial.run('cat /etc/hostname; grep -c " / " /proc/mounts; mount | grep " on / "', 30_000);
		expect(output).toContain('vmm-install');
		// The root file system is the installed disk, not the installer's RAM disk.
		expect(output).toMatch(/\/dev\/vda\d on \/ /);
		await serial.line('poweroff');
		await waitForState('stopped', 2 * 60_000);
	}, 10 * 60_000);
});
