// 00-auth.spec.ts — runs first (alphabetical ordering) to establish the
// authenticated session that subsequent specs reuse via fixtures.ts.
//
// Flow:
//  1. Hit https://crucible.jmal.io  (the UI)
//  2. Get redirected to https://auth.lab.jmal.io/...  (Authentik)
//  3. Fill the username field, click Continue
//  4. Fill the password field, click Sign in
//  5. (optional) MFA - synthetic@lab.jmal.io has MFA disabled on purpose
//  6. Get redirected back to https://crucible.jmal.io with a session cookie
//  7. Save the resulting storage state to .auth/synthetic-state.json

import { test, expect } from '@playwright/test';
import { ensureStorageDir, loadCreds, storageStatePath } from '../lib/fixtures.ts';

test.describe.configure({ mode: 'serial' });

test('login_through_authentik', async ({ page }) => {
	const creds = loadCreds();
	ensureStorageDir();

	const start = Date.now();
	await page.goto(creds.baseURL + '/');

	// The Crucible UI redirects unauthenticated visits to its own
	// `/login` page (not directly to Authentik). Click the SSO button
	// to kick off the OIDC redirect.
	await page.waitForURL(/\/login/, { timeout: 15_000 });
	await page.getByRole('button', { name: /sign in with sso/i }).click();

	// Now we expect to land on Authentik. Authentik's flow shows a
	// username field first ("Identification" stage), then a password
	// field ("Password" stage). If the user has already authenticated
	// recently (cookies/sessions on the same browser), the
	// identification stage may be skipped and the password page
	// shown directly with the username already remembered.
	await page.waitForURL(/authentik\.jmal\.io/, { timeout: 15_000 });

	// Wait for the auth form to render (Authentik web components load
	// async). The page accessibility tree shows the inputs as `textbox`
	// roles with the label as their accessible name.
	await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

	// Identification stage — fill the username/email if present.
	const uidField = page.getByRole('textbox', { name: /email or username|^username$/i });
	if (await uidField.isVisible({ timeout: 10_000 }).catch(() => false)) {
		await uidField.fill(creds.username);
		await page.getByRole('button', { name: /^(log in|continue)$/i }).click();
	}

	// Password stage.
	const passwordField = page
		.getByRole('textbox', { name: /^password$/i })
		.or(page.locator('input[type="password"]'))
		.first();
	await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
	await passwordField.fill(creds.password);
	await page.getByRole('button', { name: /^(continue|log in|sign in)$/i }).click();

	// Authentik may show a consent screen on the very first login;
	// click through if it does.
	const consent = page.locator('button[type="submit"]:has-text("Continue")');
	if (await consent.isVisible({ timeout: 3_000 }).catch(() => false)) {
		await consent.click();
	}

	// Back on the Crucible UI.
	await page.waitForURL(creds.baseURL + '/**', { timeout: 30_000 });

	// Sanity-check the auth context is real: /auth/me should return
	// a JSON body with this user's email.
	const meResp = await page.request.get(creds.baseURL + '/api/v1/auth/me');
	expect(meResp.status(), 'expected /auth/me to be 200').toBe(200);
	const me = await meResp.json();
	expect(me.email ?? me.user?.email).toBe(creds.username);

	await page.context().storageState({ path: storageStatePath() });

	const elapsed = (Date.now() - start) / 1000;
	console.log(`login flow took ${elapsed.toFixed(2)}s`);
});
