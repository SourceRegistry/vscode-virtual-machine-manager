// Shim for SvelteKit's `$app/env` / `$app/environment` inside a VS Code webview.
export const browser = true;
export const dev = import.meta.env.DEV;
export const building = false;
export const version = '0';
