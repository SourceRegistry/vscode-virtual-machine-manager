// Shim for SvelteKit's `$app/navigation`. Webviews have no router; navigation requests are
// forwarded to listeners (the app may map them to host commands) and otherwise ignored.
type NavigateListener = (url: string) => void;
const listeners = new Set<NavigateListener>();

export function onGoto(listener: NavigateListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export async function goto(url: string | URL): Promise<void> {
	const href = url.toString();
	for (const listener of listeners) listener(href);
}

export async function invalidate(): Promise<void> {}
export async function invalidateAll(): Promise<void> {}
export async function preloadData(): Promise<void> {}
export async function preloadCode(): Promise<void> {}
export function beforeNavigate(): void {}
export function afterNavigate(): void {}
export function onNavigate(): void {}
export function pushState(): void {}
export function replaceState(): void {}
export function disableScrollHandling(): void {}
