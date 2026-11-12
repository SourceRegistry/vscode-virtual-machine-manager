/**
 * Turning a VNC frame into a PNG an AI model can look at, and its coordinates back into screen pixels. Large
 * screens are scaled down (models scale big images themselves, and then the coordinates they answer with no
 * longer match), with a fixed rule so a later click maps back without remembering anything. Pure.
 */
import { deflateSync } from 'node:zlib';
import type { Frame } from './rfb';

/** The longest side of a screenshot an agent gets. */
export const MAX_SCREENSHOT_SIDE = 1280;

/** Screenshot pixels per screen pixel (1 for screens up to 1280 pixels on their longest side). */
export function screenshotScale(width: number, height: number): number {
	return Math.min(1, MAX_SCREENSHOT_SIDE / Math.max(width, height, 1));
}

export function screenshotSize(width: number, height: number): { width: number; height: number } {
	const scale = screenshotScale(width, height);
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A point in a screenshot to the screen pixel it shows; rejects points outside the screenshot. */
export function toScreen(x: number, y: number, screen: { width: number; height: number }): { x: number; y: number } {
	const shot = screenshotSize(screen.width, screen.height);
	if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) throw new Error(`(${x}, ${y}) is outside the screen, which is ${shot.width} × ${shot.height} in screenshots.`);
	const scale = screenshotScale(screen.width, screen.height);
	return { x: Math.min(screen.width - 1, Math.round(x / scale)), y: Math.min(screen.height - 1, Math.round(y / scale)) };
}

/** RGB rows of the frame, scaled down by averaging the screen pixels behind each screenshot pixel. */
function rgbRows(frame: Frame): { width: number; height: number; rows: Buffer } {
	const { width, height } = screenshotSize(frame.width, frame.height);
	// One filter byte (0: none) before every row.
	const rows = Buffer.alloc((width * 3 + 1) * height);
	const sx = frame.width / width;
	const sy = frame.height / height;
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor(y * sy);
		const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
		const out = y * (width * 3 + 1);
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor(x * sx);
			const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
			let r = 0;
			let g = 0;
			let b = 0;
			for (let yy = y0; yy < y1; yy++) {
				for (let xx = x0; xx < x1; xx++) {
					const i = (yy * frame.width + xx) * 4;
					b += frame.pixels[i];
					g += frame.pixels[i + 1];
					r += frame.pixels[i + 2];
				}
			}
			const n = (y1 - y0) * (x1 - x0);
			const o = out + 1 + x * 3;
			rows[o] = Math.round(r / n);
			rows[o + 1] = Math.round(g / n);
			rows[o + 2] = Math.round(b / n);
		}
	}
	return { width, height, rows };
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(data: Buffer): number {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, 'latin1');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** The frame as a PNG (8-bit RGB), scaled down to at most `MAX_SCREENSHOT_SIDE` pixels on its longest side. */
export function framePng(frame: Frame): { png: Buffer; width: number; height: number } {
	const { width, height, rows } = rgbRows(frame);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, no filter method, no interlace
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
	return { png, width, height };
}
