// 01-auth-admin.spec.ts — logs in as the instructor/admin synthetic account
// and saves storage state for specs that need an elevated role.
//
// Mirrors 00-auth.spec.ts exactly, but reads from SYNTHETIC_ADMIN_USERNAME /
// SYNTHETIC_ADMIN_PASSWORD and writes to .auth/synthetic-admin-state.json.
//
// Ordered with the 01- prefix so it runs immediately after the student auth
// spec, before any admin-authenticated checks.
//
// If SYNTHETIC_ADMIN_USERNAME is not set the entire spec is skipped; the
// admin-dependent specs (image-library, template-wizard-iso, runner-results)
// also check this variable and skip accordingly, so the suite degrades
// gracefully on environments without an instructor account configured.

import { test, expect } from '@playwright/test';
import { ensureStorageDir, adminStorageStatePath } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const ADMIN_USERNAME = process.env.SYNTHETIC_ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.SYNTHETIC_ADMIN_PASSWORD;
const BASE_URL = process.env.SYNTHETIC_BASE_URL ?? 'https://crucible.jmal.io';

test.describe.configure({ mode: 'serial' });

test.skip(
	!ADMIN_USERNAME || !ADMIN_PASSWORD,
	'SYNTHETIC_ADMIN_USERNAME / SYNTHETIC_ADMIN_PASSWORD not configured; skipping instructor auth'
);

test('login_admin_through_authentik', async ({ page }, testInfo) => {
	meta(testInfo, {
		title: 'Admin/instructor login through Authentik',
		description:
			'Logs the instructor/admin synthetic account into Crucible through the full OIDC flow and ' +
			'saves the resulting storage state for admin-authenticated specs. Failure means the admin ' +
			'account credentials are wrong, the Authentik flow is broken, or the instructor role was ' +
			'removed from the account.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-login_through_authentik-fails'
	});

	ensureStorageDir();

	const start = Date.now();
	await page.goto(BASE_URL + '/');

	await page.waitForURL(/\/login/, { timeout: 15_000 });
	await page.getByRole('button', { name: /sign in with sso/i }).click();

	await page.waitForURL(/authentik\.jmal\.io/, { timeout: 15_000 });
	await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

	const uidField = page.getByRole('textbox', { name: /email or username|^username$/i });
	if (await uidField.isVisible({ timeout: 10_000 }).catch(() => false)) {
		await uidField.fill(ADMIN_USERNAME!);
		await page.getByRole('button', { name: /^(log in|continue)$/i }).click();
	}

	const passwordField = page.locator('input[type="password"]').and(page.locator(':visible')).first();
	await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
	await passwordField.click();
	await passwordField.fill(ADMIN_PASSWORD!);
	const filled = await passwordField.inputValue();
	if (filled.length !== ADMIN_PASSWORD!.length) {
		throw new Error(
			`password fill failed: expected ${ADMIN_PASSWORD!.length} chars, got ${filled.length}`
		);
	}
	await page.getByRole('button', { name: /^(continue|log in|sign in)$/i }).click();

	if (page.url().includes('authentik.jmal.io')) {
		const consent = page.locator('button[type="submit"]:has-text("Continue")');
		if (await consent.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await consent.click().catch(() => {});
		}
	}

	await page.waitForURL(BASE_URL + '/**', { timeout: 30_000 });

	const meResp = await page.request.get(BASE_URL + '/auth/me');
	expect(meResp.status(), 'expected /auth/me to be 200 after admin login').toBe(200);
	const me = await meResp.json();
	expect(me.email ?? me.user?.email).toBe(ADMIN_USERNAME);

	// Assert the ROLE, not just that a session exists. Without this the spec
	// claims to detect "the instructor role was removed from the account" but
	// would happily pass for a demoted student account -- and the three
	// dependent specs would then fail with confusing "heading not visible"
	// errors that point at the UI rather than at the account.
	const role = me.role ?? me.user?.role;
	expect(
		['instructor', 'admin'],
		`admin synthetic account must hold the instructor or admin role, got "${role}". ` +
			'The admin-authenticated UI checks cannot pass without it.'
	).toContain(role);

	await page.context().storageState({ path: adminStorageStatePath() });

	const elapsed = (Date.now() - start) / 1000;
	console.log(`admin login flow took ${elapsed.toFixed(2)}s`);
});
