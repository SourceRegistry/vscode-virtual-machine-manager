import { describe, expect, it } from 'vitest';
import { deleteVmDetail } from '../src/shared/deleteDetail';

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
