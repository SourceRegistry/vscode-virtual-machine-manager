/**
 * Keys an agent asks for, as X11 keysyms (what VNC sends): key combinations such as `ctrl+alt+delete`,
 * `enter` or `F5`, and text typed character by character (with Shift where a US keyboard needs it). Pure.
 */

const NAMED: Record<string, number> = {
	enter: 0xff0d, return: 0xff0d, tab: 0xff09, escape: 0xff1b, esc: 0xff1b, backspace: 0xff08, delete: 0xffff, del: 0xffff,
	insert: 0xff63, home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56, left: 0xff51, up: 0xff52, right: 0xff53,
	down: 0xff54, space: 0x20, plus: 0x2b, printscreen: 0xff61, capslock: 0xffe5, menu: 0xff67,
	ctrl: 0xffe3, control: 0xffe3, shift: 0xffe1, alt: 0xffe9, option: 0xffe9, meta: 0xffeb, super: 0xffeb, win: 0xffeb, cmd: 0xffeb, command: 0xffeb
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = 0xffbe + i - 1;

const SHIFT = 0xffe1;
/** Characters that need Shift on a US keyboard. */
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ');

/** The keysym of one character (Latin-1 directly, other Unicode through the 0x01000000 range). */
function charKeysym(char: string): number {
	if (char === '\n') return NAMED.enter;
	if (char === '\t') return NAMED.tab;
	const code = char.codePointAt(0)!;
	return code < 0x100 ? code : 0x01000000 + code;
}

/** One key event: down or up. */
export interface KeyStroke {
	keysym: number;
	down: boolean;
}

/** `ctrl+alt+delete` → press ctrl, alt, delete, release in reverse. Throws on an unknown key name. */
export function comboStrokes(combo: string): KeyStroke[] {
	const parts = combo.split('+').map((p) => p.trim());
	if (parts.some((p) => !p)) throw new Error(`"${combo}" is not a key combination: write keys like "enter" or "ctrl+c" (the + key is "plus").`);
	const keysyms = parts.map((name) => {
		if ([...name].length === 1) return charKeysym(name);
		const keysym = NAMED[name.toLowerCase()];
		if (keysym === undefined) throw new Error(`Unknown key "${name}". Use a character or one of: ${Object.keys(NAMED).filter((k) => !/^f\d/.test(k)).join(', ')}, f1-f12.`);
		return keysym;
	});
	return [...keysyms.map((keysym) => ({ keysym, down: true })), ...[...keysyms].reverse().map((keysym) => ({ keysym, down: false }))];
}

/** Text typed one character at a time, holding Shift where a US keyboard needs it. */
export function textStrokes(text: string): KeyStroke[] {
	const strokes: KeyStroke[] = [];
	for (const char of text) {
		const keysym = charKeysym(char);
		const shift = SHIFTED.has(char);
		if (shift) strokes.push({ keysym: SHIFT, down: true });
		strokes.push({ keysym, down: true }, { keysym, down: false });
		if (shift) strokes.push({ keysym: SHIFT, down: false });
	}
	return strokes;
}
