/**
 * Text → key strokes for "Type Clipboard Text": consoles without a clipboard channel (Hyper-V
 * basic session, VNC, text-mode guests) only understand key presses. Keys follow the US layout,
 * which is what most installers and Linux consoles default to.
 */

export interface KeyStroke {
	/** `KeyboardEvent.code` (physical key). */
	code: string;
	/** `KeyboardEvent.key` (produced character or key name). */
	key: string;
	shift: boolean;
}

const US_KEYS = new Map<string, KeyStroke>();

function add(char: string, code: string, shift: boolean): void {
	US_KEYS.set(char, { code, key: char, shift });
}

for (let i = 0; i < 26; i++) {
	const lower = String.fromCharCode(97 + i);
	const code = `Key${lower.toUpperCase()}`;
	add(lower, code, false);
	add(lower.toUpperCase(), code, true);
}
')!@#$%^&*('.split('').forEach((shifted, digit) => {
	add(String(digit), `Digit${digit}`, false);
	add(shifted, `Digit${digit}`, true);
});
for (const [code, plain, shifted] of [
	['Minus', '-', '_'],
	['Equal', '=', '+'],
	['BracketLeft', '[', '{'],
	['BracketRight', ']', '}'],
	['Backslash', '\\', '|'],
	['Semicolon', ';', ':'],
	['Quote', "'", '"'],
	['Backquote', '`', '~'],
	['Comma', ',', '<'],
	['Period', '.', '>'],
	['Slash', '/', '?']
]) {
	add(plain, code, false);
	add(shifted, code, true);
}
add(' ', 'Space', false);
US_KEYS.set('\n', { code: 'Enter', key: 'Enter', shift: false });
US_KEYS.set('\t', { code: 'Tab', key: 'Tab', shift: false });

/** One Enter per line break, whatever the line ending. */
export function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/** The US-layout key for a character, or undefined when it has none (e.g. "é", emoji). */
export function usKey(char: string): KeyStroke | undefined {
	return US_KEYS.get(char);
}

/** Key strokes for `text`; characters without a US key are counted in `skipped`. */
export function keyStrokes(text: string): { strokes: KeyStroke[]; skipped: number } {
	const strokes: KeyStroke[] = [];
	let skipped = 0;
	for (const char of normalizeNewlines(text)) {
		const stroke = usKey(char);
		if (stroke) strokes.push(stroke);
		else skipped++;
	}
	return { strokes, skipped };
}

export const XK_SHIFT_L = 0xffe1;
const XK_RETURN = 0xff0d;
const XK_TAB = 0xff09;

/** X11 keysym of a character (VNC sends keysyms; the server maps them to keys). */
export function keysym(char: string): number {
	if (char === '\n') return XK_RETURN;
	if (char === '\t') return XK_TAB;
	const cp = char.codePointAt(0)!;
	// Latin-1 keysyms equal the code point; everything else uses the Unicode keysym range.
	return cp < 0x100 ? cp : 0x01000000 + cp;
}

/** Pause between characters so the guest keeps up (keyboard buffers are small). */
export const TYPING_DELAY_MS = 8;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
