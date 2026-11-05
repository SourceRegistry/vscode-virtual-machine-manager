import { describe, expect, it } from 'vitest';
import { originLabel } from '../src/shared/origin';

describe('originLabel', () => {
	it('labels attached and imported VMs, and nothing else', () => {
		expect(originLabel({ origin: 'adopted' })).toBe('external');
		expect(originLabel({ origin: 'adopted', controllable: false })).toBe('external · observe only');
		expect(originLabel({ origin: 'imported' })).toBe('imported');
		expect(originLabel({})).toBeUndefined();
	});
});
