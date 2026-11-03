import { describe, expect, it } from 'vitest';
import { keyStrokes, keysym, normalizeNewlines, usKey } from '../src/lib/client/console/typing';

describe('clipboard typing', () => {
	it('maps characters to US-layout keys with shift', () => {
		expect(usKey('a')).toEqual({ code: 'KeyA', key: 'a', shift: false });
		expect(usKey('A')).toEqual({ code: 'KeyA', key: 'A', shift: true });
		expect(usKey('1')).toEqual({ code: 'Digit1', key: '1', shift: false });
		expect(usKey('!')).toEqual({ code: 'Digit1', key: '!', shift: true });
		expect(usKey(')')).toEqual({ code: 'Digit0', key: ')', shift: true });
		expect(usKey('"')).toEqual({ code: 'Quote', key: '"', shift: true });
		expect(usKey('\\')).toEqual({ code: 'Backslash', key: '\\', shift: false });
		expect(usKey(' ')?.code).toBe('Space');
		expect(usKey('\n')?.code).toBe('Enter');
		expect(usKey('é')).toBeUndefined();
	});

	it('types one Enter per line break and counts characters it cannot type', () => {
		const { strokes, skipped } = keyStrokes('ls -la\r\ncd ~\rpwd\nnaïve');
		expect(strokes.filter((s) => s.code === 'Enter')).toHaveLength(3);
		expect(strokes.map((s) => s.key).join('')).toBe('ls -laEntercd ~EnterpwdEnternave');
		expect(skipped).toBe(1);
		expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
	});

	it('uses X11 keysyms for VNC', () => {
		expect(keysym('a')).toBe(0x61);
		expect(keysym('é')).toBe(0xe9);
		expect(keysym('\n')).toBe(0xff0d);
		expect(keysym('\t')).toBe(0xff09);
		expect(keysym('€')).toBe(0x01000000 + 0x20ac);
	});
});
