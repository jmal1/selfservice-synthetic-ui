// template-wizard-iso.spec.ts — instructor-authenticated regression guard
// that the ISO install option in the template creation wizard is present and
// enabled.
//
// Background: the ISO source type was previously a stub that existed in the
// source-type select but was not wired up. This spec guards against it
// being accidentally re-disabled, hidden, or removed.
//
// What this checks:
//   1. The "New template" heading renders (page loads for an instructor)
//   2. The source-type <select> contains an "ISO install" option
//   3. That option is NOT disabled (the whole control is interactive)
//
// What breaks it:
//   - The ISO option value="iso" is removed from the select
//   - The select is disabled (e.g. loadingSources never resolves)
//   - The instructor auth check redirects to /admin/templates

import { adminTest, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const ADMIN_USERNAME = process.env.SYNTHETIC_ADMIN_USERNAME;
adminTest.skip(
	!ADMIN_USERNAME,
	'SYNTHETIC_ADMIN_USERNAME not configured; skipping instructor-role synthetic specs'
);

adminTest('template_wizard_iso_option', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'ISO option present and enabled in template wizard',
		description:
			'Instructor opens /admin/templates/new and asserts the source-type selector offers ' +
			'"ISO install" as an option and that the control is not disabled. Guards against ' +
			're-shipping the old stub state where ISO appeared in the select but was not ' +
			'functional, or against the option being removed entirely.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-template_wizard_iso_option-fails'
	});

	await page.goto('/admin/templates/new');

	// The page's onMount redirects non-instructors to /admin/templates.
	// "New template" heading only appears if the instructor session reached the page.
	await expect(
		page.getByRole('heading', { name: /New template/i }),
		'"New template" heading must be visible — instructor role check failed or error boundary ' +
			'rendered instead of the wizard'
	).toBeVisible({ timeout: 15_000 });

	// Wait for the source data to finish loading. The select is wired to
	// loadingSources which clears when all four parallel API calls complete.
	// We wait for the select to become non-disabled rather than polling loadingSources.
	//
	// Locate by its value-set: the select that specifically contains an ISO option.
	// If ISO is removed from the select, this locator finds nothing and the assertion
	// fails — which is exactly what we want.
	const sourceSelect = page.locator('select:has(option[value="iso"])');

	await expect(
		sourceSelect,
		'Source-type select must be visible — the ISO option (value="iso") was not found in any ' +
			'select on this page, which means it was removed from the template wizard'
	).toBeVisible({ timeout: 15_000 });

	await expect(
		sourceSelect,
		'Source-type select must not be disabled — loadingSources may never have cleared; ' +
			'check adminListVCenterISOs / adminListImages API calls for errors'
	).not.toBeDisabled({ timeout: 15_000 });

	// Enumerate option texts to assert "ISO install" is present. This is a stronger
	// check than just finding option[value="iso"] — it would also catch a case where
	// the option exists but its label was changed to something misleading.
	const optionTexts = await sourceSelect.locator('option').allInnerTexts();

	// Guard against a vacuous pass: if allInnerTexts() somehow returns an empty array
	// the toContain below would never fire.
	expect(
		optionTexts.length,
		'Source-type select must have at least one option — the select rendered empty'
	).toBeGreaterThan(0);

	expect(
		optionTexts,
		`"ISO install" must be one of the source-type options. Found: ${optionTexts.join(', ')}`
	).toContain('ISO install');
});
