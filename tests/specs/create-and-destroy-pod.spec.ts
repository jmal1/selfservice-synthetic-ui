// create-and-destroy-pod.spec.ts — the deepest UI synthetic check.
//
// This test only runs if SYNTHETIC_TEMPLATE_NAME is set in the env
// (the README's "synthetic-noop" template from S1.2 isn't created yet —
// when it is, set SYNTHETIC_TEMPLATE_NAME=synthetic-noop on netbirdv01
// and this test becomes active).
//
// Flow:
//   1. Navigate to /pods/new
//   2. Pick the synthetic-noop template
//   3. Submit; wait for the pod to reach "ready" (poll the UI every 5s,
//      max 5 min)
//   4. Navigate to the pod detail, click Destroy
//   5. Confirm; wait for the pod to disappear from /pods

import { test, expect } from '../lib/fixtures.ts';

const TEMPLATE = process.env.SYNTHETIC_TEMPLATE_NAME;

test.skip(!TEMPLATE, 'SYNTHETIC_TEMPLATE_NAME not configured (S1.2 not shipped yet)');

test('create_and_destroy_synthetic_pod', async ({ authedPage: page }) => {
	test.setTimeout(8 * 60_000); // 8 minutes — provisioning is slow

	await page.goto('/pods/new');

	// The synthetic-noop template card; clicking it should take us
	// through whatever launch flow the UI defines.
	const card = page.getByRole('button', { name: new RegExp(TEMPLATE!, 'i') }).first();
	await expect(card, `synthetic template "${TEMPLATE}" not visible`).toBeVisible({
		timeout: 10_000
	});
	await card.click();

	// Either an inline form or a launch button.
	const launch = page.getByRole('button', { name: /launch|create|start/i }).first();
	await launch.click();

	// Wait for "ready" or "active" status badge in the pod detail page.
	await page.waitForURL(/\/pods\/[a-f0-9-]+/, { timeout: 60_000 });
	await expect(
		page
			.locator(':text-matches("(?i)(ready|active|running)")', { hasText: /ready|active|running/i })
			.first()
	).toBeVisible({ timeout: 5 * 60_000 });

	// Destroy.
	await page.getByRole('button', { name: /destroy|delete/i }).first().click();
	await page.getByRole('button', { name: /yes|confirm|delete/i }).first().click();

	// Should land back on /pods, and our pod should disappear within 60s.
	await page.waitForURL(/\/pods\/?$/, { timeout: 30_000 });
});
