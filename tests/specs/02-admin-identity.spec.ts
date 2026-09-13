// 02-admin-identity.spec.ts — the meta-check that makes missing instructor
// coverage VISIBLE.
//
// Why this file exists
// --------------------
// image-library, both template-wizard specs, and workflows-authoring need an
// instructor-role session, and those checks call `adminTest.skip()` when
// SYNTHETIC_ADMIN_USERNAME is unset. (runner_results_render is student-owned and
// does not use this gate.) The Pushgateway reporter deliberately does not push
// a result for a skipped test (pushgateway-reporter.ts), and pushResults PUTs
// the whole metric group, which Pushgateway replaces wholesale. So an
// environment without instructor credentials does not get RED checks for those
// specs — it gets checks that DO NOT EXIST.
//
// Every alert we have is shaped `1 - crucible_synthetic_ui_check_success > 0`,
// which cannot match a series that is absent. The board would read a clean
// green while the entire authenticated admin UI had silently stopped being
// tested.
//
// This check is therefore registered UNCONDITIONALLY and never skips, so a
// series is always present and flips to 0 when coverage is lost. It is the
// direct counterpart of `elevated_identity_configured` in the Go API suite,
// which exists for exactly the same reason.
//
// severity=warning on purpose: lost coverage is a weekday fix, not a page.
// And a fresh environment that has never configured an instructor account
// gets ONE clearly-named check telling it what to set, rather than five
// confusingly absent ones.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { adminStorageStatePath } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

test('admin_identity_configured', async ({}, testInfo) => {
	meta(testInfo, {
		title: 'Instructor synthetic identity is configured',
		description:
			'Reports whether an instructor-role account is configured for the UI synthetic suite. ' +
			'When it is not, the image library, template wizard, and authoring checks skip and push ' +
			'NO metrics at all, so their absence cannot trigger any alert and the admin UI silently ' +
			'stops being tested. Set SYNTHETIC_ADMIN_USERNAME and SYNTHETIC_ADMIN_PASSWORD in the ' +
			'operator secrets env file to restore that coverage.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-admin_identity_configured-fails'
	});

	const username = process.env.SYNTHETIC_ADMIN_USERNAME;
	const password = process.env.SYNTHETIC_ADMIN_PASSWORD;

	expect(
		Boolean(username && password),
		'SYNTHETIC_ADMIN_USERNAME / SYNTHETIC_ADMIN_PASSWORD are not set, so the instructor-role ' +
			'UI checks (image library, template wizard, and authoring) are ' +
			'skipping and pushing no metrics. Their absence is invisible to every alert we have. ' +
			'Configure both in the operator secrets env file (see private deploy docs).'
	).toBe(true);

	// Credentials being present is necessary but not sufficient: if the OIDC
	// login failed, 01-auth-admin.spec.ts goes red but the five dependent
	// checks fail with confusing "heading not visible" errors instead. Assert
	// the saved session actually exists so this check names the real cause.
	const statePath = adminStorageStatePath();
	expect(
		fs.existsSync(statePath),
		`Instructor credentials are configured but no saved session exists at ${statePath}. ` +
			'The Authentik login in 01-auth-admin.spec.ts did not complete, so the instructor-role ' +
			'checks cannot run. Check that check first.'
	).toBe(true);
});
