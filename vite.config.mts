import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const shim = (name: string) => r(`./src/lib/client/shims/${name}`);

/**
 * Webview bundle. client-lib is written for SvelteKit; a webview cannot run SvelteKit, so the
 * `$app/*`, `$env/*` and `@sveltejs/kit` modules it imports are aliased to small shims in
 * src/lib/client/shims. client-lib itself stays untouched.
 */
export default defineConfig(({ mode }) => ({
	base: './',
	plugins: [svelte()],
	resolve: {
		alias: [
			{ find: /^\$app\/env(ironment)?$/, replacement: shim('app-env.ts') },
			{ find: /^\$app\/state$/, replacement: shim('app-state.svelte.ts') },
			{ find: /^\$app\/stores$/, replacement: shim('app-stores.ts') },
			{ find: /^\$app\/navigation$/, replacement: shim('app-navigation.ts') },
			{ find: /^\$app\/forms$/, replacement: shim('app-forms.ts') },
			{ find: /^\$env\/(dynamic|static)\/public$/, replacement: shim('env-public.ts') },
			{ find: /^@sveltejs\/kit$/, replacement: shim('kit.ts') },
			{ find: /^@sourceregistry\/sveltekit-service-manager\/client$/, replacement: shim('service-manager.ts') },
			{ find: /^\$lib\//, replacement: `${r('./src/lib')}/` },
			{ find: /^#lib\//, replacement: `${r('./src/lib')}/` },
			{ find: /^@vmm\/sdk$/, replacement: r('./packages/sdk/src/index.ts') }
		]
	},
	build: {
		outDir: 'dist/webview',
		emptyOutDir: true,
		target: 'es2022',
		cssCodeSplit: false,
		modulePreload: false,
		sourcemap: mode === 'development',
		minify: mode !== 'development',
		chunkSizeWarningLimit: 2048,
		rolldownOptions: {
			input: r('./src/lib/client/main.ts'),
			output: {
				format: 'es',
				codeSplitting: false,
				entryFileNames: 'main.js',
				assetFileNames: (asset) =>
					(asset.names?.[0] ?? '').endsWith('.css') ? 'main.css' : 'assets/[name][extname]'
			}
		}
	}
}));
