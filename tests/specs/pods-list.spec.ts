// pods-list.spec.ts — authenticated home page loads, no 500s.
//
// Asserts the dashboard renders, the pods table is in the DOM (even if
// empty), and there are no console errors during the load.

import { test, expect } from '../lib/fixtures.ts';

test('dashboard_renders_for_synthetic_user', async ({ authedPage: page }) => {
	const consoleErrors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') consoleErrors.push(msg.text());
	});

	await page.goto('/');

	// The pods route or dashboard. The actual route depends on what the
	// SvelteKit root redirects to for authenticated users — by default
	// it lands on /pods.
	await expect(page).toHaveURL(/\/(pods|dashboard)?\/?$/, { timeout: 15_000 });

	// Either the "No pods yet" empty state or a pods table heading.
	const hasPodsHeading = await page
		.locator('h1, h2')
		.filter({ hasText: /pods|dashboard/i })
		.first()
		.isVisible({ timeout: 10_000 })
		.catch(() => false);
	expect(hasPodsHeading, 'expected a Pods or Dashboard heading on the home page').toBe(true);

	// Allow benign console noise (warnings, deprecations) but flag
	// genuine error-level messages that didn't originate from a known
	// third-party (e.g. Sentry beacon failures).
	const realErrors = consoleErrors.filter(
		(e) => !/sentry|analytics|beacon|favicon/i.test(e)
	);
	expect(realErrors, `unexpected console errors: ${realErrors.join(' / ')}`).toHaveLength(0);
});
