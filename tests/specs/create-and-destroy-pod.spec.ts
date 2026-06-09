// create-and-destroy-pod.spec.ts — the deepest UI synthetic check.
//
// Activated when SYNTHETIC_TEMPLATE_NAME is set in the env on the runner
// (typically synthetic-noop). The /pods/new route is a multi-step wizard
// post-T4; this spec walks it step by step.
//
// Wizard path (custom flow):
//   1. Destination -> "New Environment"
//   2. Mode        -> "Custom Environment"
//   3. Name        -> environment name input
//   4. Templates   -> increase quantity to 1 for the synthetic template card
//   5. Resources   -> defaults are pre-filled from the template, just Next
//   6. Review      -> "Deploy Environment"
// Then:
//   - Wait for /pods/{id}
//   - Wait for status badge to show active/ready
//   - Click "Delete Pod" then "Confirm Delete"
//   - Wait for landing back on /pods

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const TEMPLATE = process.env.SYNTHETIC_TEMPLATE_NAME;

test.skip(!TEMPLATE, 'SYNTHETIC_TEMPLATE_NAME not configured');

test('create_and_destroy_synthetic_pod', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Create + destroy a synthetic-noop pod (full lifecycle)',
		description: `Walks the multi-step /pods/new wizard with template "${TEMPLATE ?? '?'}", waits for active status, then destroys via the pod detail page. Deepest end-to-end UI check: exercises wizard state machine, provisioning worker, vCenter clone, NetBird onboarding, and destroy path. A failure usually means the wizard broke (selectors changed) or the worker is stalled — cross-check pod_lifecycle API synthetic and worker logs.`,
		severity: 'critical',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-create_and_destroy_pod-fails'
	});
	// 3min wizard + 4min provisioning + 90s destroy + slack.
	test.setTimeout(8 * 60_000);

	const envName = `synthetic-${Date.now()}`;

	// ── Step 1: Destination ────────────────────────────────────────────
	await page.goto('/pods/new');
	await page.getByRole('button', { name: /New Environment/i }).click();
	await page.getByRole('button', { name: /^Next$/ }).click();

	// ── Step 2: Mode ───────────────────────────────────────────────────
	await page.getByRole('button', { name: /Custom Environment/i }).click();
	await page.getByRole('button', { name: /^Next$/ }).click();

	// ── Step 3: Name ───────────────────────────────────────────────────
	await page.getByLabel(/Environment Name/i).fill(envName);
	await page.getByRole('button', { name: /^Next$/ }).click();

	// ── Step 4: Templates ──────────────────────────────────────────────
	// Each template card is a rounded <div> (class includes "rounded-2xl")
	// containing an <h3> for the name and an "Increase quantity" button.
	// Plain `locator('div').filter(...)` matches every ancestor div so we
	// anchor on the unique card class.
	const templateCard = page
		.locator('div.rounded-2xl.p-5')
		.filter({ has: page.getByRole('heading', { name: new RegExp(`^${TEMPLATE}$`, 'i') }) });
	await expect(templateCard, `template "${TEMPLATE}" card not visible`).toBeVisible({
		timeout: 10_000
	});
	await templateCard.getByRole('button', { name: 'Increase quantity', exact: true }).click();
	await page.getByRole('button', { name: /^Next$/ }).click();

	// ── Step 5: Resources ──────────────────────────────────────────────
	// VM inputs are pre-populated from template defaults; just continue.
	await page.getByRole('button', { name: /^Next$/ }).click();

	// ── Step 6: Review → Deploy ────────────────────────────────────────
	await page.getByRole('button', { name: /Deploy Environment/i }).click();

	// After successful create the app navigates back to "/" (dashboard).
	// The new pod appears in the list as a row containing envName; from
	// there we click the "View pod details" link to land on /pods/{id}.
	await page.waitForURL((url) => url.pathname === '/', { timeout: 60_000 });

	const newPodRow = page
		.locator('li, tr, div')
		.filter({ hasText: envName })
		.filter({ has: page.getByRole('link', { name: /View pod details/i }) })
		.first();
	await expect(newPodRow, `new pod row "${envName}" not visible on dashboard`).toBeVisible({
		timeout: 30_000
	});
	await newPodRow.getByRole('link', { name: /View pod details/i }).click();
	await page.waitForURL(/\/pods\/[a-f0-9-]+/, { timeout: 15_000 });

	// ── Wait for status badge to leave provisioning ────────────────────
	// StatusBadge text shows the pod.status verbatim; the worker walks
	// pending -> provisioning -> active for happy path. We accept any
	// terminal "running" state.
	await expect(
		page.getByText(/\b(active|ready|running)\b/i).first()
	).toBeVisible({ timeout: 5 * 60_000 });

	// ── Destroy: two-step confirm ──────────────────────────────────────
	await page.getByRole('button', { name: /^Delete Pod$/ }).click();
	await page.getByRole('button', { name: /^Confirm Delete$/ }).click();

	// ── Should land back on /pods within 60s ───────────────────────────
	await page.waitForURL(/\/pods\/?(?:$|\?)/, { timeout: 60_000 });
});

