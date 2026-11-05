/**
 * Turns the providers' cumulative `VmStats` counters into the rate series the dashboard charts.
 * Pure: no DOM, no vscode. Unit tested.
 */
import type { DiskStats, VmStats } from '@vmm/sdk';

/** Seconds of history the charts keep. */
export const WINDOW_SECONDS = 300;

/** One chart point. `null` = no data (gap in the line), never a fake zero. */
export interface MetricPoint {
	/** Seconds since the epoch. */
	t: number;
	cpu: number | null;
	memoryUsedMB: number | null;
	memoryMB: number | null;
	readBps: number | null;
	writeBps: number | null;
	readIops: number | null;
	writeIops: number | null;
	/** Average service time of the requests completed in the interval. */
	readLatencyMs: number | null;
	writeLatencyMs: number | null;
	rxBps: number | null;
	txBps: number | null;
	diskUsedBytes: number | null;
	diskCapacityBytes: number | null;
	uptimeSeconds: number | null;
}

interface DiskTotals {
	readBytes: number;
	writeBytes: number;
	readOps: number;
	writeOps: number;
	readTimeNs: number | undefined;
	writeTimeNs: number | undefined;
}

/** Sums all disks; time counters are only summed when every disk reports them. */
export function diskTotals(disks: DiskStats[] | undefined): DiskTotals | undefined {
	if (!disks?.length) return undefined;
	const total: DiskTotals = { readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, readTimeNs: 0, writeTimeNs: 0 };
	for (const d of disks) {
		total.readBytes += d.readBytes;
		total.writeBytes += d.writeBytes;
		total.readOps += d.readOps;
		total.writeOps += d.writeOps;
		total.readTimeNs = total.readTimeNs !== undefined && d.readTimeNs !== undefined ? total.readTimeNs + d.readTimeNs : undefined;
		total.writeTimeNs = total.writeTimeNs !== undefined && d.writeTimeNs !== undefined ? total.writeTimeNs + d.writeTimeNs : undefined;
	}
	return total;
}

/**
 * Rates between two samples. The first sample has no rates; a counter that went backwards (the VM
 * restarted) also yields no rates for that interval instead of a huge negative spike.
 */
export function derivePoint(previous: VmStats | undefined, current: VmStats): MetricPoint {
	const point: MetricPoint = {
		t: current.timestamp / 1000,
		cpu: current.cpuUsage ?? null,
		memoryUsedMB: current.memoryUsedMB ?? null,
		memoryMB: current.memoryMB ?? null,
		readBps: null,
		writeBps: null,
		readIops: null,
		writeIops: null,
		readLatencyMs: null,
		writeLatencyMs: null,
		rxBps: null,
		txBps: null,
		diskUsedBytes: current.diskUsage?.usedBytes ?? null,
		diskCapacityBytes: current.diskUsage?.capacityBytes ?? null,
		uptimeSeconds: current.uptimeSeconds ?? null
	};
	const before = diskTotals(previous?.disks);
	const now = diskTotals(current.disks);
	const seconds = previous ? (current.timestamp - previous.timestamp) / 1000 : 0;
	const restarted = previous?.uptimeSeconds !== undefined && current.uptimeSeconds !== undefined && current.uptimeSeconds < previous.uptimeSeconds;
	if (seconds <= 0 || restarted) return point;
	const rate = (before: number | undefined, now: number | undefined) => before !== undefined && now !== undefined && now >= before ? (now - before) / seconds : null;
	point.rxBps = rate(previous?.network?.rxBytes, current.network?.rxBytes);
	point.txBps = rate(previous?.network?.txBytes, current.network?.txBytes);
	point.readBps = rate(previous?.diskIo?.readBytes, current.diskIo?.readBytes);
	point.writeBps = rate(previous?.diskIo?.writeBytes, current.diskIo?.writeBytes);
	if (!before || !now || seconds <= 0) return point;

	const dRb = now.readBytes - before.readBytes;
	const dWb = now.writeBytes - before.writeBytes;
	const dRo = now.readOps - before.readOps;
	const dWo = now.writeOps - before.writeOps;
	if (dRb < 0 || dWb < 0 || dRo < 0 || dWo < 0) return point;

	point.readBps = dRb / seconds;
	point.writeBps = dWb / seconds;
	point.readIops = dRo / seconds;
	point.writeIops = dWo / seconds;
	if (now.readTimeNs !== undefined && before.readTimeNs !== undefined && dRo > 0) {
		const d = now.readTimeNs - before.readTimeNs;
		if (d >= 0) point.readLatencyMs = d / dRo / 1e6;
	}
	if (now.writeTimeNs !== undefined && before.writeTimeNs !== undefined && dWo > 0) {
		const d = now.writeTimeNs - before.writeTimeNs;
		if (d >= 0) point.writeLatencyMs = d / dWo / 1e6;
	}
	return point;
}

/** Keeps only the last `windowSeconds` of points (by timestamp). */
export function trimWindow(points: MetricPoint[], windowSeconds = WINDOW_SECONDS): MetricPoint[] {
	const last = points[points.length - 1];
	if (!last) return points;
	const cutoff = last.t - windowSeconds;
	const first = points.findIndex((p) => p.t >= cutoff);
	return first <= 0 ? points : points.slice(first);
}

/** Column-major data for uPlot: `[times, ...series]`. */
export function column(points: MetricPoint[], keys: Array<keyof Omit<MetricPoint, 't'>>): Array<Array<number | null>> {
	return [points.map((p) => p.t), ...keys.map((key) => points.map((p) => p[key]))];
}

// ---- formatting -------------------------------------------------------------------------------

export function formatPercent(fraction: number | null | undefined): string {
	return fraction === null || fraction === undefined ? '–' : `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`;
}

export function formatRate(bytesPerSecond: number | null | undefined): string {
	if (bytesPerSecond === null || bytesPerSecond === undefined) return '–';
	const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
	let value = bytesPerSecond;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatIops(value: number | null | undefined): string {
	return value === null || value === undefined ? '–' : `${value >= 100 ? Math.round(value) : value.toFixed(1)} IOPS`;
}

export function formatLatency(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '–';
	return ms < 1 ? `${Math.round(ms * 1000)} µs` : ms < 100 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined) return '–';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// ---- axis ticks -------------------------------------------------------------------------------

/**
 * Clean tick values from 0 up to `max`, at most `target + 1` of them. Plain numbers step by 1, 2 or
 * 5 times a power of ten; byte quantities (`binary`) step by a power of two times a power of 1024, so a
 * memory axis reads 0 / 512 MB / 1 GB / 1.5 GB / 2 GB and a rate axis 0 / 2 / 4 / 6 / 8 MB/s instead
 * of 0 / 1.9 / 3.8 / 5.7 / 7.6 MB/s.
 */
export function niceTicks(max: number, binary = false, target = 4): number[] {
	if (!(max > 0)) return [0];
	const raw = max / target;
	const radix = binary ? 1024 : 10;
	const base = radix ** Math.floor(Math.log(raw) / Math.log(radix));
	const candidates = binary ? [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024] : [1, 2, 5, 10];
	const step = (candidates.find((c) => max / (c * base) <= target + 0.5) ?? candidates[candidates.length - 1]!) * base;
	const ticks: number[] = [];
	for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
	return ticks;
}
