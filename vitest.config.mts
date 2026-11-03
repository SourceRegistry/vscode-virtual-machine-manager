import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			'@vmm/sdk': fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url))
		}
	},
	test: {
		include: ['test/**/*.test.ts', 'extensions/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
		environment: 'node'
	}
});
