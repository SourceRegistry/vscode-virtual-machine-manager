import { describe, expect, it } from 'vitest';
import { usableAccelerators } from '../src/definition';
import { parseAccelHelp } from '../src/detect';
import { cpuLoadBetween, parseMemAvailable, parseVmStat } from '../src/hostInfo';

describe('parseVmStat', () => {
	// Captured from macOS (16 KB pages): only ~190 MB "free", ~4 GB really available.
	const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    11848.
Pages active:                                 243794.
Pages inactive:                               242122.
Pages speculative:                               859.
Pages throttled:                                   0.
Pages wired down:                             150571.
Pages purgeable:                                4165.
"Translation faults":                      162651463.`;

	it('counts free, inactive, speculative and purgeable pages as available', () => {
		expect(parseVmStat(vmStat)).toBe(Math.round(((11848 + 242122 + 859 + 4165) * 16384) / 1048576));
		expect(parseVmStat(vmStat)).toBeGreaterThan(4000);
	});

	it('returns undefined for output it does not understand', () => {
		expect(parseVmStat('')).toBeUndefined();
		expect(parseVmStat('command not found')).toBeUndefined();
	});
});

describe('parseMemAvailable', () => {
	it('reads MemAvailable from /proc/meminfo', () => {
		expect(parseMemAvailable('MemTotal:       16384000 kB\nMemFree:          500000 kB\nMemAvailable:   8192000 kB\n')).toBe(8000);
		expect(parseMemAvailable('MemTotal: 1 kB')).toBeUndefined();
	});
});

describe('cpuLoadBetween', () => {
	it('derives load from idle vs total deltas', () => {
		expect(cpuLoadBetween(undefined, { idle: 10, total: 20 })).toBeUndefined();
		expect(cpuLoadBetween({ idle: 100, total: 200 }, { idle: 175, total: 300 })).toBeCloseTo(0.25);
		expect(cpuLoadBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeUndefined();
		expect(cpuLoadBetween({ idle: 0, total: 0 }, { idle: 0, total: 100 })).toBe(1);
	});
});

describe('accelerators', () => {
	it('parses `-accel help`', () => {
		expect(parseAccelHelp('Accelerators supported in QEMU binary:\ntcg\nhvf\n')).toEqual(['tcg', 'hvf']);
		expect(parseAccelHelp('Accelerators supported in QEMU binary:\r\ntcg\r\n')).toEqual(['tcg']);
		expect(parseAccelHelp('')).toEqual([]);
	});

	it('drops accelerators the binary lacks but always keeps TCG', () => {
		expect(usableAccelerators(['hvf', 'tcg'], ['tcg'])).toEqual(['tcg']);
		expect(usableAccelerators(['hvf', 'tcg'], ['tcg', 'hvf'])).toEqual(['hvf', 'tcg']);
		expect(usableAccelerators(['whpx,kernel-irqchip=off', 'tcg'], ['tcg', 'whpx'])).toEqual(['whpx,kernel-irqchip=off', 'tcg']);
		expect(usableAccelerators(['kvm'], ['hvf'])).toEqual(['tcg']);
	});

	it('filters nothing when the list is unknown', () => {
		expect(usableAccelerators(['hvf', 'tcg'], [])).toEqual(['hvf', 'tcg']);
	});
});
