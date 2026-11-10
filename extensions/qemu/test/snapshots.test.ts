import { describe, expect, it } from 'vitest';
import { commonSnapshots, qmpSnapshots, snapshotNameProblem } from '../src/snapshots';

// Shapes copied from QEMU 11.1: `query-block` while a VM ran, and `qemu-img info --output=json`.
const s1 = { 'vm-clock-nsec': 123523000, name: 's1', 'date-sec': 1794291111, 'date-nsec': 350666000, 'vm-clock-sec': 2, id: '1', 'vm-state-size': 0 };
const s2 = { ...s1, name: 'before upgrade', id: '2', 'date-sec': 1794291200 };

describe('snapshot names', () => {
	it('accepts the characters a VM name accepts', () => {
		for (const name of ['clean', 'before upgrade', 'v1.2 (rc)', 'a'.repeat(64)]) expect(snapshotNameProblem(name)).toBeUndefined();
	});

	it('rejects empty, long, padded and special-character names', () => {
		for (const name of ['', 'a'.repeat(65), ' lead', 'trail ', 'a,b', 'a/b', 'semi;colon']) expect(snapshotNameProblem(name)).toBeTruthy();
	});
});

describe('commonSnapshots', () => {
	it('maps one disk, oldest first, with milliseconds and the memory flag', () => {
		expect(commonSnapshots([[s2, s1]])).toEqual([
			{ id: 's1', name: 's1', createdAt: 1794291111000, includesMemory: false },
			{ id: 'before upgrade', name: 'before upgrade', createdAt: 1794291200000, includesMemory: false }
		]);
	});

	it('marks a snapshot that holds VM state', () => {
		expect(commonSnapshots([[{ ...s1, 'vm-state-size': 4096 }]])[0]).toMatchObject({ includesMemory: true });
	});

	it('keeps only snapshots every disk has, so a half-taken one is never offered', () => {
		expect(commonSnapshots([[s1, s2], [s1]]).map((s) => s.name)).toEqual(['s1']);
		expect(commonSnapshots([[s1], []])).toEqual([]);
	});

	it('is empty without disks or snapshots', () => {
		expect(commonSnapshots([])).toEqual([]);
		expect(commonSnapshots([[]])).toEqual([]);
	});
});

describe('qmpSnapshots', () => {
	const blocks = [
		{ device: 'disk0', inserted: { 'node-name': '#block123', image: { format: 'qcow2', snapshots: [s1] } } },
		{ device: 'cd0', inserted: { 'node-name': '#block200', image: { format: 'raw' } } },
		{ device: 'pflash1', inserted: { image: { format: 'raw' } } }
	];

	it('finds a disk by its drive id and returns its snapshots', () => {
		expect(qmpSnapshots(blocks, ['disk0'])).toEqual([[s1]]);
	});

	it('gives an empty list for a disk QEMU does not report or that has none', () => {
		expect(qmpSnapshots(blocks, ['disk1', 'cd0'])).toEqual([[], []]);
	});
});
