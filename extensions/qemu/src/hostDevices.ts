/** Reading host USB / PCI devices and running the one privileged step VFIO needs. */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parseLsusb, parseSystemProfilerUsb, PCI_ADDRESS, type PciHostDevice, type UsbHostDevice } from './passthrough';

const execFileAsync = promisify(execFile);

/** Host USB devices. Rejects with a readable reason when this platform cannot list them. */
export async function listUsbHost(): Promise<UsbHostDevice[]> {
	if (process.platform === 'win32') throw new Error('QEMU on Windows cannot pass USB devices through.');
	if (process.platform === 'darwin') {
		const { stdout } = await execFileAsync('system_profiler', ['SPUSBDataType', '-json'], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
		return parseSystemProfilerUsb(stdout);
	}
	try {
		const { stdout } = await execFileAsync('lsusb', [], { timeout: 10_000 });
		return parseLsusb(stdout);
	} catch {
		return listUsbFromSysfs();
	}
}

/** Without `lsusb`: `/sys/bus/usb/devices/<dev>/{idVendor,idProduct,product}`. */
async function listUsbFromSysfs(): Promise<UsbHostDevice[]> {
	const root = '/sys/bus/usb/devices';
	const entries = await fs.promises.readdir(root).catch(() => {
		throw new Error('Could not list USB devices (install usbutils for lsusb).');
	});
	const read = (dir: string, file: string) => fs.promises.readFile(path.join(root, dir, file), 'utf8').then((t) => t.trim(), () => undefined);
	const devices: UsbHostDevice[] = [];
	for (const entry of entries) {
		const [vendor, product, name] = await Promise.all([read(entry, 'idVendor'), read(entry, 'idProduct'), read(entry, 'product')]);
		if (!vendor || !product) continue;
		const vendorId = parseInt(vendor, 16);
		if (vendorId === 0x1d6b) continue;
		devices.push({ vendorId, productId: parseInt(product, 16), name: name || 'USB device' });
	}
	return devices;
}

const PCI_ROOT = '/sys/bus/pci/devices';

export function iommuEnabled(): boolean {
	try {
		return fs.readdirSync('/sys/kernel/iommu_groups').length > 0;
	} catch {
		return false;
	}
}

/** All PCI devices of a Linux host. */
export async function listPciHost(): Promise<PciHostDevice[]> {
	const entries = await fs.promises.readdir(PCI_ROOT);
	const devices: PciHostDevice[] = [];
	const text = (dir: string, file: string) => fs.promises.readFile(path.join(PCI_ROOT, dir, file), 'utf8').then((t) => t.trim(), () => undefined);
	const link = (dir: string, file: string) => fs.promises.readlink(path.join(PCI_ROOT, dir, file)).then((t) => path.basename(t), () => undefined);
	for (const address of entries) {
		if (!PCI_ADDRESS.test(address)) continue;
		const [vendor, device, klass, driver, group, bootVga] = await Promise.all([
			text(address, 'vendor'),
			text(address, 'device'),
			text(address, 'class'),
			link(address, 'driver'),
			link(address, 'iommu_group'),
			text(address, 'boot_vga')
		]);
		if (!vendor || !device || !klass) continue;
		devices.push({
			address,
			vendorId: parseInt(vendor, 16),
			deviceId: parseInt(device, 16),
			classCode: parseInt(klass, 16),
			driver,
			iommuGroup: group !== undefined && /^\d+$/.test(group) ? Number(group) : undefined,
			bootVga: bootVga === '1'
		});
	}
	return devices;
}

/** The driver bound to a device right now. */
export function pciDriver(address: string): string | undefined {
	try {
		return path.basename(fs.readlinkSync(path.join(PCI_ROOT, address, 'driver')));
	} catch {
		return undefined;
	}
}

/**
 * Runs shell lines as root through polkit (`pkexec`). The caller has shown the exact lines to the
 * user and got a yes. There is no `sudo` fallback: it would need a terminal for the password.
 */
export async function runPrivileged(lines: readonly string[]): Promise<void> {
	if (process.platform !== 'linux') throw new Error('Privileged device changes are only supported on Linux.');
	try {
		await execFileAsync('pkexec', ['/bin/sh', '-c', lines.join('\n')], { timeout: 120_000 });
	} catch (error) {
		const e = error as { stderr?: string; message: string; code?: number | string };
		if (e.code === 'ENOENT') throw new Error('pkexec (polkit) was not found. Run these commands as root yourself, then try again:\n' + lines.join('\n'));
		if (e.code === 126 || e.code === 127) throw new Error('The authentication was cancelled or refused.');
		throw new Error(`The privileged step failed: ${(e.stderr || e.message).trim()}`);
	}
}
