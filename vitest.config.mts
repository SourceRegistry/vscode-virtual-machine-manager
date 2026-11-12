import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: [
			// Node-only subpaths (`@vmm/sdk/provisioning`, `@vmm/sdk/guest`): a directory with an index.ts each.
			{ find: /^@vmm\/sdk\/([\w-]+)$/, replacement: fileURLToPath(new URL('./packages/sdk/src/$1/index.ts', import.meta.url)) },
			{ find: /^@vmm\/sdk$/, replacement: fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url)) }
		]
	},
	test: {
		include: ['test/**/*.test.ts', 'extensions/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
		environment: 'node'
	}
});
