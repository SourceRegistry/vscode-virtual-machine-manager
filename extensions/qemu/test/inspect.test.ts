import { describe, expect, it } from 'vitest';
import {
	cpuUsageBetween,
	guestIpAddresses,
	hasMedia,
	nicDevice,
	parseBlockDevices,
	parseBlockStats,
	parsePciDevices,
	parseProcStat,
	parsePsSample,
	parsePsTime,
	removableQdev,
	type QmpBlock
} from '../src/inspect';

// Shapes captured from QEMU 11.1 `query-block` (trimmed).
const blocks: QmpBlock[] = [
	{
		device: 'disk0',
		qdev: '/machine/peripheral-anon/device[0]',
		removable: false,
		inserted: { ro: false, drv: 'qcow2', file: '/vms/a/disk0.qcow2', image: { filename: '/vms/a/disk0.qcow2', format: 'qcow2', 'virtual-size': 67108864 } }
	},
	{
		device: 'cd0',
		qdev: '/machine/peripheral-anon/device[1]',
		removable: true,
		tray_open: false,
		inserted: { ro: true, drv: 'raw', file: '/isos/debian.iso', image: { filename: '/isos/debian.iso', format: 'raw', 'virtual-size': 2097152 } }
	},
	{ device: 'floppy0', removable: true },
	{ device: 'sd0', removable: true }
];

describe('parseBlockDevices', () => {
	it('maps disks and CD drives, skipping empty built-in floppy/sd slots', () => {
		const devices = parseBlockDevices(blocks, { diskBus: 'virtio' });
		expect(devices).toEqual([
			{ id: 'disk0', kind: 'disk', label: 'Hard disk 1', path: '/vms/a/disk0.qcow2', sizeBytes: 67108864, format: 'qcow2', bus: 'virtio', readOnly: false },
			{ id: 'cd0', kind: 'cdrom', label: 'CD/DVD drive', path: '/isos/debian.iso', sizeBytes: 2097152, format: 'raw', bus: 'sata', readOnly: true, removable: true }
		]);
	});

	it('keeps an empty CD drive that belongs to the VM', () => {
		const empty = blocks.map((b) => (b.device === 'cd0' ? { ...b, inserted: undefined } : b));
		const cd = parseBlockDevices(empty, { diskBus: 'sata' }).find((d) => d.id === 'cd0');
		// An empty drive has no medium but must stay listed so the user can insert one.
		expect(cd).toMatchObject({ kind: 'cdrom', removable: true, path: undefined });
	});

	it('orders disks before CD drives and numbers disks naturally', () => {
		const many: QmpBlock[] = [
			{ device: 'cd0', removable: true, inserted: { file: 'x.iso' } },
			{ device: 'disk10', inserted: { file: 'b' } },
			{ device: 'disk2', inserted: { file: 'a' } }
		];
		expect(parseBlockDevices(many, { diskBus: 'sata' }).map((d) => d.id)).toEqual(['disk2', 'disk10', 'cd0']);
	});
});

describe('media helpers', () => {
	it('finds the QOM path QEMU 11 needs for eject', () => {
		expect(removableQdev(blocks, 'cd0')).toBe('/machine/peripheral-anon/device[1]');
		expect(removableQdev(blocks, 'disk0')).toBeUndefined();
		expect(removableQdev(blocks, 'nope')).toBeUndefined();
	});

	it('detects inserted media only on removable drives', () => {
		expect(hasMedia(blocks)).toBe(true);
		expect(hasMedia(blocks.filter((b) => !b.removable))).toBe(false);
		expect(hasMedia(blocks.map((b) => (b.device === 'cd0' ? { ...b, inserted: undefined } : b)))).toBe(false);
	});
});

describe('parseBlockStats', () => {
	it('exposes cumulative counters per device', () => {
		const stats = parseBlockStats([
			{ device: 'disk0', stats: { rd_bytes: 512, wr_bytes: 1024, rd_operations: 1, wr_operations: 2, rd_total_time_ns: 90000, wr_total_time_ns: 5, flush_operations: 3, flush_total_time_ns: 7 } },
			{ stats: { rd_bytes: 1 } },
			{ device: 'nostats' }
		]);
		expect(stats).toEqual([
			{ id: 'disk0', readBytes: 512, writeBytes: 1024, readOps: 1, writeOps: 2, readTimeNs: 90000, writeTimeNs: 5, flushOps: 3, flushTimeNs: 7 }
		]);
	});
});

describe('parsePciDevices', () => {
	it('formats addresses and ids, descending into bridges', () => {
		const devices = parsePciDevices([
			{
				bus: 0,
				devices: [
					{ bus: 0, slot: 1, function: 0, class_info: { desc: 'VGA controller' }, id: { vendor: 0x1234, device: 0x1111 }, qdev_id: '' },
					{
						bus: 0,
						slot: 28,
						function: 0,
						class_info: { desc: 'PCI bridge' },
						id: { vendor: 0x1b36, device: 0x000c },
						pci_bridge: { devices: [{ bus: 1, slot: 0, function: 0, class_info: { desc: 'Ethernet controller' }, id: { vendor: 0x1af4, device: 0x1000 }, qdev_id: 'net0' }] }
					}
				]
			}
		]);
		expect(devices.map((d) => [d.address, d.label, d.description])).toEqual([
			['00:01.0', 'VGA controller', '1234:1111'],
			['00:1c.0', 'PCI bridge', '1b36:000c'],
			['01:00.0', 'Ethernet controller', '1af4:1000 · net0']
		]);
	});
});

describe('network helpers', () => {
	const ifaces = [
		{ name: 'lo', 'hardware-address': '00:00:00:00:00:00', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' as const }] },
		{
			name: 'eth0',
			'hardware-address': '52:54:00:AB:CD:EF',
			'ip-addresses': [
				{ 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6' as const },
				{ 'ip-address': '2001:db8::5', 'ip-address-type': 'ipv6' as const },
				{ 'ip-address': '10.0.2.15', 'ip-address-type': 'ipv4' as const }
			]
		}
	];

	it('lists IPv4 before IPv6 and drops loopback / link-local', () => {
		expect(guestIpAddresses(ifaces[1])).toEqual(['10.0.2.15', '2001:db8::5']);
		expect(guestIpAddresses(ifaces[0])).toEqual([]);
		expect(guestIpAddresses(undefined)).toEqual([]);
	});

	it('matches the guest interface by MAC, case-insensitively', () => {
		const [nic] = nicDevice('e1000', '52:54:00:ab:cd:ef', ifaces, true);
		expect(nic).toMatchObject({ mac: '52:54:00:ab:cd:ef', ipAddresses: ['10.0.2.15', '2001:db8::5'], connected: true, model: 'e1000' });
	});

	it('falls back to QEMU\'s default MAC and no IPs without an agent', () => {
		const [nic] = nicDevice('virtio-net-pci', undefined, undefined, false);
		expect(nic).toMatchObject({ mac: '52:54:00:12:34:56', ipAddresses: undefined, connected: false });
		expect(nicDevice('none', undefined, undefined, true)).toEqual([]);
	});
});

describe('host process samples', () => {
	it('parses ps time formats', () => {
		expect(parsePsTime('0:01.23')).toBeCloseTo(1.23);
		expect(parsePsTime('1:02:03')).toBe(3723);
		expect(parsePsTime('1-00:00:10')).toBe(86410);
		expect(parsePsTime('garbage')).toBeUndefined();
	});

	it('parses a ps sample', () => {
		expect(parsePsSample('  0:12.50  204800\n')).toEqual({ cpuSeconds: 12.5, rssMB: 200 });
		expect(parsePsSample('')).toBeUndefined();
	});

	it('parses /proc stat even when the command name has spaces and parentheses', () => {
		const stat = '1234 (qemu (x86) sys) S 1 1 1 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 5 0 100 0 0';
		expect(parseProcStat(stat, 'Name:\tqemu\nVmRSS:\t  102400 kB\n')).toEqual({ cpuSeconds: 3, rssMB: 100 });
	});

	it('derives CPU usage from two samples, clamped to the vCPU count', () => {
		const a = { at: 0, cpuSeconds: 10 };
		expect(cpuUsageBetween(undefined, a, 2)).toBeUndefined();
		expect(cpuUsageBetween(a, { at: 2000, cpuSeconds: 11 }, 2)).toBeCloseTo(0.25);
		expect(cpuUsageBetween(a, { at: 1000, cpuSeconds: 20 }, 2)).toBe(1);
		expect(cpuUsageBetween(a, { at: 0, cpuSeconds: 10 }, 2)).toBeUndefined();
	});
});
