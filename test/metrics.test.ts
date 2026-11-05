import { describe, expect, it } from 'vitest';
import type { VmStats } from '@vmm/sdk';
import { column, derivePoint, diskTotals, formatBytes, formatLatency, formatPercent, formatRate, niceTicks, trimWindow } from '../src/shared/metrics';

const stats = (timestamp: number, disk: Partial<NonNullable<VmStats['disks']>[number]> = {}, extra: Partial<VmStats> = {}): VmStats => ({
	timestamp,
	cpuUsage: 0.5,
	memoryUsedMB: 512,
	memoryMB: 2048,
	disks: [{ id: 'disk0', readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, readTimeNs: 0, writeTimeNs: 0, ...disk }],
	...extra
});

describe('derivePoint', () => {
	it('derives aggregate disk and network rates without inventing IOPS', () => {
		const a: VmStats = { timestamp: 1000, uptimeSeconds: 20, diskIo: { readBytes: 100, writeBytes: 200 }, network: { rxBytes: 300, txBytes: 400 } };
		const b: VmStats = { timestamp: 3000, uptimeSeconds: 22, diskIo: { readBytes: 500, writeBytes: 800 }, network: { rxBytes: 1100, txBytes: 1400 }, diskUsage: { usedBytes: 1024, capacityBytes: 4096 } };
		expect(derivePoint(a, b)).toMatchObject({ readBps: 200, writeBps: 300, rxBps: 400, txBps: 500, diskUsedBytes: 1024, diskCapacityBytes: 4096, readIops: null, readLatencyMs: null, uptimeSeconds: 22 });
		expect(derivePoint(a, { ...b, uptimeSeconds: 1 })).toMatchObject({ readBps: null, rxBps: null });
		expect(derivePoint(b, a)).toMatchObject({ readBps: null, rxBps: null });
	});
	it('has no rates for the first sample', () => {
		const p = derivePoint(undefined, stats(10_000));
		expect(p).toMatchObject({ t: 10, cpu: 0.5, memoryUsedMB: 512, memoryMB: 2048, readBps: null, writeLatencyMs: null });
	});

	it('derives throughput, IOPS and average latency from counter deltas', () => {
		const a = stats(0, { readBytes: 1000, readOps: 10, readTimeNs: 1_000_000, writeBytes: 0, writeOps: 0 });
		const b = stats(2000, { readBytes: 3000, readOps: 30, readTimeNs: 5_000_000, writeBytes: 4000, writeOps: 8, writeTimeNs: 16_000_000 });
		const p = derivePoint(a, b);
		expect(p.readBps).toBe(1000);
		expect(p.writeBps).toBe(2000);
		expect(p.readIops).toBe(10);
		expect(p.writeIops).toBe(4);
		expect(p.readLatencyMs).toBeCloseTo(0.2); // 4 ms over 20 reads
		expect(p.writeLatencyMs).toBeCloseTo(2); // 16 ms over 8 writes
	});

	it('leaves latency empty (a gap, not a zero) when no request completed', () => {
		const a = stats(0, { readOps: 5, readTimeNs: 100 });
		const p = derivePoint(a, stats(1000, { readOps: 5, readTimeNs: 100 }));
		expect(p.readIops).toBe(0);
		expect(p.readLatencyMs).toBeNull();
	});

	it('drops rates when a counter went backwards (VM restarted)', () => {
		const p = derivePoint(stats(0, { readBytes: 9000, readOps: 90 }), stats(1000, { readBytes: 100, readOps: 1 }));
		expect(p.readBps).toBeNull();
		expect(p.readIops).toBeNull();
	});

	it('copes with providers that report no disks or no timing counters', () => {
		expect(derivePoint(stats(0), { timestamp: 1000, cpuUsage: 0.1 }).readBps).toBeNull();
		const a = stats(0, { readBytes: 0, readOps: 0, readTimeNs: undefined });
		const b = stats(1000, { readBytes: 10, readOps: 1, readTimeNs: undefined });
		const p = derivePoint(a, b);
		expect(p.readBps).toBe(10);
		expect(p.readLatencyMs).toBeNull();
	});

	it('ignores a non-increasing clock', () => {
		expect(derivePoint(stats(5000, { readBytes: 0 }), stats(5000, { readBytes: 100 })).readBps).toBeNull();
	});
});

describe('diskTotals', () => {
	it('sums disks and only keeps time when every disk has it', () => {
		const t = diskTotals([
			{ id: 'a', readBytes: 1, writeBytes: 2, readOps: 3, writeOps: 4, readTimeNs: 5, writeTimeNs: 6 },
			{ id: 'b', readBytes: 10, writeBytes: 20, readOps: 30, writeOps: 40, readTimeNs: 50 }
		]);
		expect(t).toEqual({ readBytes: 11, writeBytes: 22, readOps: 33, writeOps: 44, readTimeNs: 55, writeTimeNs: undefined });
		expect(diskTotals([])).toBeUndefined();
		expect(diskTotals(undefined)).toBeUndefined();
	});
});

describe('window and columns', () => {
	const points = Array.from({ length: 10 }, (_, i) => derivePoint(undefined, stats(i * 100_000)));
	it('trims to the window by timestamp', () => {
		const trimmed = trimWindow(points, 300);
		expect(trimmed.map((p) => p.t)).toEqual([600, 700, 800, 900]);
		expect(trimWindow([], 300)).toEqual([]);
		expect(trimWindow(points.slice(0, 2), 300)).toHaveLength(2);
	});

	it('builds uPlot columns, time first', () => {
		const cols = column(points.slice(0, 2), ['cpu', 'memoryUsedMB']);
		expect(cols).toEqual([[0, 100], [0.5, 0.5], [512, 512]]);
	});
});

describe('formatters', () => {
	it('formats values and missing data', () => {
		expect(formatPercent(0.034)).toBe('3.4%');
		expect(formatPercent(0.5)).toBe('50%');
		expect(formatPercent(null)).toBe('–');
		expect(formatRate(0)).toBe('0 B/s');
		expect(formatRate(1536)).toBe('1.5 KB/s');
		expect(formatRate(250 * 1024 * 1024)).toBe('250 MB/s');
		expect(formatLatency(0.2)).toBe('200 µs');
		expect(formatLatency(2.34)).toBe('2.3 ms');
		expect(formatLatency(null)).toBe('–');
		expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
	});
});

describe('niceTicks', () => {
	const mb = 1024 * 1024;

	it('steps plain numbers by 1, 2 or 5 times a power of ten', () => {
		expect(niceTicks(1)).toEqual([0, 0.5, 1]);
		expect(niceTicks(180)).toEqual([0, 50, 100, 150]);
		expect(niceTicks(200)).toEqual([0, 50, 100, 150, 200]);
		expect(niceTicks(10)).toEqual([0, 5, 10]);
	});

	it('steps byte quantities by powers of two', () => {
		expect(niceTicks(9.5 * mb, true).map((v) => v / mb)).toEqual([0, 4, 8]);
		expect(niceTicks(75 * mb, true).map((v) => v / mb)).toEqual([0, 32, 64]);
		expect(niceTicks(2048, true)).toEqual([0, 512, 1024, 1536, 2048]);
		expect(niceTicks(70_000, true).map((v) => v / 1024)).toEqual([0, 16, 32, 48, 64]);
	});

	it('never returns more than target + 1 ticks and handles empty ranges', () => {
		for (const max of [3, 17, 999, 123456, 5e9]) {
			expect(niceTicks(max).length).toBeLessThanOrEqual(6);
			expect(niceTicks(max, true).length).toBeLessThanOrEqual(6);
		}
		expect(niceTicks(0)).toEqual([0]);
		expect(niceTicks(NaN)).toEqual([0]);
		expect(niceTicks(0.0004).length).toBeGreaterThan(1);
	});
});
