import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const shim = (name: string) => r(`./src/lib/client/shims/${name}`);

/** Vendored IronRDP (see vendor/ironrdp/README.md). */
const IRONRDP = /[\\/]vendor[\\/]ironrdp[\\/]/;

/** Ships the IronRDP WebAssembly module next to main.js; the RDP console gets its URL from the host. */
function ironRdpWasm(): Plugin {
	return {
		name: 'vmm-ironrdp-wasm',
		apply: 'build',
		generateBundle() {
			this.emitFile({
				type: 'asset',
				fileName: 'ironrdp_web_bg.wasm',
				source: readFileSync(r('./vendor/ironrdp/pkg/ironrdp_web_bg.wasm'))
			});
		}
	};
}

/**
 * Webview bundle. client-lib is written for SvelteKit; a webview cannot run SvelteKit, so the
 * `$app/*`, `$env/*` and `@sveltejs/kit` modules it imports are aliased to small shims in
 * src/lib/client/shims. client-lib itself stays untouched.
 */
export default defineConfig(({ mode }) => ({
	base: './',
	plugins: [
		svelte({
			// IronRDP's <iron-remote-desktop> is authored as a custom element that renders into its own
			// shadow root, so its styles must be injected there (main.css cannot reach inside).
			dynamicCompileOptions: ({ filename }) => (IRONRDP.test(filename) ? { customElement: true, css: 'injected' } : undefined)
		}),
		ironRdpWasm()
	],
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
			{ find: /^ua-parser-js$/, replacement: shim('ua-parser.ts') },
			{ find: /^virtual:ironrdp-element$/, replacement: r('./vendor/ironrdp/iron-remote-desktop/iron-remote-desktop.svelte') },
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
