/**
 * Keeps client-lib's `data-theme` attribute in sync with the VS Code theme kind. VS Code sets
 * `vscode-light | vscode-dark | vscode-high-contrast | vscode-high-contrast-light` on <body>
 * and swaps it live when the user changes theme.
 */
export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export function currentThemeKind(): ThemeKind {
	const classes = document.body.classList;
	if (classes.contains('vscode-high-contrast-light')) return 'high-contrast-light';
	if (classes.contains('vscode-high-contrast')) return 'high-contrast';
	if (classes.contains('vscode-light')) return 'light';
	return 'dark';
}

const listeners = new Set<(kind: ThemeKind) => void>();

export function onThemeChange(listener: (kind: ThemeKind) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function startThemeSync(): void {
	const apply = () => {
		const kind = currentThemeKind();
		document.documentElement.dataset.theme = kind === 'light' || kind === 'high-contrast-light' ? 'light' : 'dark';
		for (const listener of listeners) listener(kind);
	};
	apply();
	new MutationObserver(apply).observe(document.body, {
		attributes: true,
		attributeFilter: ['class', 'data-vscode-theme-id']
	});
}

/** Reads a VS Code theme colour (e.g. `terminal.ansiRed`) from the injected CSS variables. */
export function themeColor(id: string, fallback = ''): string {
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(`--vscode-${id.replace(/\./g, '-')}`)
		.trim();
	return value || fallback;
}
