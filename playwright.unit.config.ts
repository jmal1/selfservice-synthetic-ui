import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './unit-tests',
	fullyParallel: true,
	workers: 1,
	reporter: [['list']]
});
