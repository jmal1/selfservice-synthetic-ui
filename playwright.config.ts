import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';
import './tests/lib/config.ts';

// Playwright config for the Crucible UI synthetic suite.
//
// Single Chromium browser, sequential execution (so we can use a single
// authenticated context across specs without rate-limiting Authentik).
// All artefacts (HAR, trace, screenshot) saved on failure for forensics.
//
// Set PUSHGATEWAY_URL=skip in local dev to disable metric push.
export default defineConfig({
	testDir: './tests',
	// outputDir is a SUBDIR of test-results so the bind-mounted parent
	// (/app/test-results) is never the target of rmdir() between runs.
	outputDir: './test-results/latest',
	timeout: 90_000, // 90s per test — UI rendering + WebMKS handshake is slow
	expect: { timeout: 15_000 },
	fullyParallel: false, // sequential — one synthetic user, one browser context
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: [
		['list'],
		['html', { open: 'never', outputFolder: 'playwright-report' }],
		['./tests/lib/pushgateway-reporter.ts']
	],
	use: {
		baseURL: process.env.SYNTHETIC_BASE_URL ?? 'https://crucible.jmal.io',
		trace: 'retain-on-failure',
		video: 'retain-on-failure',
		screenshot: 'only-on-failure',
		actionTimeout: 15_000,
		navigationTimeout: 30_000,
		// Caddy sometimes serves a self-signed cert during cert renewal;
		// be lenient.
		ignoreHTTPSErrors: false
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	]
});
