// Bundles the extension-host code of the core extension and of every provider extension.
// The SDK is bundled into each extension, `vscode` stays external.
//
//   node esbuild.mjs                 build all
//   node esbuild.mjs --watch         rebuild on change
//   node esbuild.mjs --only hyperv   build one target (core | hyperv | qemu | proxmox | libvirt)
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const production = !watch && process.env.NODE_ENV !== 'development';

const targets = {
	core: { entry: 'src/extension/extension.ts', out: 'dist/extension.js' },
	hyperv: { entry: 'extensions/hyperv/src/extension.ts', out: 'extensions/hyperv/dist/extension.js' },
	libvirt: { entry: 'extensions/libvirt/src/extension.ts', out: 'extensions/libvirt/dist/extension.js' },
	proxmox: { entry: 'extensions/proxmox/src/extension.ts', out: 'extensions/proxmox/dist/extension.js' },
	qemu: { entry: 'extensions/qemu/src/extension.ts', out: 'extensions/qemu/dist/extension.js' }
};

/** @type {import('esbuild').Plugin} */
const problemMatcher = {
	name: 'problem-matcher',
	setup(build) {
		build.onStart(() => console.log(`[watch] build started: ${build.initialOptions.outfile}`));
		build.onEnd((result) => {
			for (const { text, location } of result.errors) {
				console.error(`✘ [ERROR] ${text}`);
				if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
			}
			console.log(`[watch] build finished: ${build.initialOptions.outfile}`);
		});
	}
};

const selected = Object.entries(targets).filter(([name]) => !only || name === only);
if (!selected.length) {
	console.error(`Unknown target "${only}". Use one of: ${Object.keys(targets).join(', ')}`);
	process.exit(1);
}

const contexts = await Promise.all(
	selected.map(([, target]) =>
		esbuild.context({
			entryPoints: [path.join(root, target.entry)],
			outfile: path.join(root, target.out),
			bundle: true,
			format: 'cjs',
			platform: 'node',
			target: 'node20',
			external: ['vscode'],
			alias: { '@vmm/sdk': path.join(root, 'packages/sdk/src/index.ts') },
			sourcemap: !production,
			sourcesContent: false,
			minify: production,
			logLevel: 'silent',
			plugins: [problemMatcher]
		})
	)
);

if (watch) {
	await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
	const results = await Promise.allSettled(contexts.map((ctx) => ctx.rebuild()));
	await Promise.all(contexts.map((ctx) => ctx.dispose()));
	const failed = results.filter((r) => r.status === 'rejected');
	if (failed.length) process.exit(1);
}
