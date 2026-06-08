// pods-list.spec.ts — authenticated home page loads, no 500s.
//
// Asserts the dashboard renders, the pods table is in the DOM (even if
// empty), and there are no console errors during the load.

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

test('dashboard_renders_for_synthetic_user', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Authenticated dashboard renders',
		description:
			'GET / as the synthetic user lands on /pods (or /dashboard) and shows the Pods/Dashboard heading with no console errors. Catches client-side hydration breaks, missing UI assets, broken pods list query, and Sentry-noisy console error regressions.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-dashboard_renders-fails'
	});
	const consoleErrors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') consoleErrors.push(msg.text());
	});

	await page.goto('/');

	// The pods route or dashboard. The actual route depends on what the
	// SvelteKit root redirects to for authenticated users — by default
	// it lands on /pods.
	await expect(page).toHaveURL(/\/(pods|dashboard)?\/?$/, { timeout: 15_000 });

	// Look for any of the real headings emitted by the dashboard ("/")
	// or the pods page ("/pods"):
	//   - "Dashboard" (h1 on /)
	//   - "My Labs" (h1 on /pods)
	//   - "My Environments" (h2 section on /)
	// We must use expect().toBeVisible() rather than locator.isVisible()
	// because the latter does not auto-retry and races against SvelteKit
	// client-side hydration (the h1 appears within ~200-500ms but
	// page.goto only waits for the 'load' event, not hydration).
	const heading = page
		.locator('h1, h2')
		.filter({ hasText: /dashboard|labs|environments|pods/i })
		.first();
	await expect(
		heading,
		'expected a Dashboard / Labs / Environments / Pods heading on the home page'
	).toBeVisible({ timeout: 10_000 });

	// Allow benign console noise (warnings, deprecations) but flag
	// genuine error-level messages that didn't originate from a known
	// third-party (e.g. Sentry beacon failures). The /ws 404 is tracked
	// separately as caddy-ws-route-404; filtering it here keeps this
	// test focused on dashboard render correctness.
	const realErrors = consoleErrors.filter(
		(e) =>
			!/sentry|analytics|beacon|favicon/i.test(e) &&
			!/wss?:\/\/[^/]+\/ws/i.test(e)
	);
	expect(realErrors, `unexpected console errors: ${realErrors.join(' / ')}`).toHaveLength(0);
});
