// Shim for SvelteKit's `$app/state`. A webview is a single page, so `page` is mostly static.
export const page = $state({
	url: new URL(location.href),
	params: {} as Record<string, string>,
	route: { id: null as string | null },
	status: 200,
	error: null as App.Error | null,
	data: {} as Record<string, unknown>,
	form: null as unknown,
	state: {} as Record<string, unknown>
});

export const navigating = { from: null, to: null, type: null, willUnload: false, delta: undefined, complete: null };

export const updated = {
	current: false,
	check: async () => false
};

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace App {
		interface Error {
			message: string;
		}
	}
}
