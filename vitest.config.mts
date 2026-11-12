import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@vmm\/sdk\/provisioning$/, replacement: fileURLToPath(new URL('./packages/sdk/src/provisioning/index.ts', import.meta.url)) },
			{ find: /^@vmm\/sdk$/, replacement: fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url)) }
		]
	},
	test: {
		include: ['test/**/*.test.ts', 'extensions/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
		environment: 'node'
	}
});
