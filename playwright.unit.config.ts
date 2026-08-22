import { defineConfig } from '@playwright/test';

process.env.SYNTHETIC_TEMPLATE_NAME ??= 'synthetic-noop';

export default defineConfig({
	testDir: './unit-tests',
	fullyParallel: true,
	workers: 1,
	reporter: [['list']]
});
