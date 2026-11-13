import { describe, expect, it } from 'vitest';
import { deleteVmDetail, deleteVmsDetail } from '../src/shared/deleteDetail';

describe('deleteVmDetail', () => {
	it('is the plain warning without snapshots or when the count is unknown', () => {
		const plain = 'This cannot be undone. A running machine is powered off first.';
		expect(deleteVmDetail(undefined)).toBe(plain);
		expect(deleteVmDetail(0)).toBe(plain);
	});

	it('says what each choice does with one snapshot', () => {
		const text = deleteVmDetail(1);
		expect(text).toContain('1 snapshot is stored');
		expect(text).toContain('"Delete VM and Disks" removes it too');
		expect(text).toContain('"Delete VM" keeps the disk files, with the snapshot,');
	});

	it('uses the plural for several', () => {
		const text = deleteVmDetail(3);
		expect(text).toContain('3 snapshots are stored');
		expect(text).toContain('removes them too');
	});
});

describe('deleteVmsDetail', () => {
	it('names the machines and warns once', () => {
		const text = deleteVmsDetail(['a', 'b']);
		expect(text.startsWith('a, b')).toBe(true);
		expect(text).toContain('This cannot be undone.');
		expect(text).not.toContain('left alone');
	});

	it('shortens a long list', () => {
		const names = Array.from({ length: 13 }, (_, i) => 'vm' + i);
		expect(deleteVmsDetail(names)).toContain('vm9 and 3 more');
	});

	it('says how many selected machines are left out', () => {
		expect(deleteVmsDetail(['a'], 1)).toContain('1 other selected machine cannot be deleted and is left alone.');
		expect(deleteVmsDetail(['a'], 2)).toContain('2 other selected machines cannot be deleted and are left alone.');
	});
});
