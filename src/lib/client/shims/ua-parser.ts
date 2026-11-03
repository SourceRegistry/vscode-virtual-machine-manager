/**
 * Stand-in for `ua-parser-js`, which IronRDP's keyboard scancode table uses only to tell browser
 * engines apart. VS Code webviews always run in Electron's Chromium (Blink).
 */
export default class UAParser {
	getResult(): { engine: { name: string; version: string } } {
		const chromium = /Chrome\/([\d.]+)/.exec(globalThis.navigator?.userAgent ?? '');
		return { engine: { name: 'Blink', version: chromium?.[1] ?? '999' } };
	}
}
