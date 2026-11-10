import { describe, expect, it } from 'vitest';
import { guestLabel, originLabel } from './origin';

describe('guest badges', () => {
	it('labels containers only', () => {
		expect(guestLabel({ guestKind: 'container' })).toBe('container');
		expect(guestLabel({ guestKind: 'vm' })).toBeUndefined();
		expect(guestLabel({})).toBeUndefined();
	});
	it('labels templates', () => {
		expect(originLabel({ template: true })).toBe('template');
	});
});
