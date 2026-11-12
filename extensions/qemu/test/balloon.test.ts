import { describe, expect, it } from 'vitest';
import { balloonUsedMB } from '../src/balloon';

const MiB = 1024 * 1024;

describe('balloonUsedMB', () => {
	it('is total minus available', () => {
		expect(balloonUsedMB({ 'stat-total-memory': 2048 * MiB, 'stat-available-memory': 1536 * MiB, 'stat-free-memory': 900 * MiB }, 1_700_000_000)).toBe(512);
	});
	it('is unknown before the guest reported, without a driver, or with unsupported stats', () => {
		expect(balloonUsedMB({ 'stat-total-memory': 2048 * MiB, 'stat-available-memory': 1536 * MiB }, 0)).toBeUndefined();
		expect(balloonUsedMB(undefined, 1)).toBeUndefined();
		expect(balloonUsedMB({ 'stat-total-memory': -1, 'stat-available-memory': -1 }, 1)).toBeUndefined();
		expect(balloonUsedMB({ 'stat-total-memory': 10, 'stat-available-memory': 20 }, 1)).toBeUndefined();
	});
});
