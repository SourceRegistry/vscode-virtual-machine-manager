import { describe, expect, it } from 'vitest';
import { escapeTelnet, TelnetFilter } from '../src/telnet';

describe('TelnetFilter', () => {
	it('drops option negotiation QEMU sends', () => {
		const filter = new TelnetFilter();
		// IAC WILL ECHO, IAC WILL SGA, IAC DONT LINEMODE, then text
		expect(filter.feed(Buffer.from([0xff, 0xfb, 0x01, 0xff, 0xfb, 0x03, 0xff, 0xfe, 0x22, 0x6f, 0x6b])).toString()).toBe('ok');
	});
	it('handles commands split across chunks and subnegotiation', () => {
		const filter = new TelnetFilter();
		expect(filter.feed(Buffer.from([0x61, 0xff])).toString()).toBe('a');
		expect(filter.feed(Buffer.from([0xfd, 0x18, 0x62])).toString()).toBe('b');
		expect(filter.feed(Buffer.from([0xff, 0xfa, 0x18, 0x00, 0xff, 0xf0, 0x63])).toString()).toBe('c');
	});
	it('unescapes a doubled IAC to one 0xFF byte', () => {
		expect([...new TelnetFilter().feed(Buffer.from([0xff, 0xff, 0x41]))]).toEqual([0xff, 0x41]);
	});
});

describe('escapeTelnet', () => {
	it('doubles 0xFF and leaves other bytes alone', () => {
		expect([...escapeTelnet(Buffer.from([0x41, 0xff, 0x42]))]).toEqual([0x41, 0xff, 0xff, 0x42]);
		const plain = Buffer.from('hello');
		expect(escapeTelnet(plain)).toBe(plain);
	});
});
