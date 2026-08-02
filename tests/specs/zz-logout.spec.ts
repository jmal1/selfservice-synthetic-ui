// zz-logout.spec.ts — logout terminates the session (regression lockdown).
//
// Named with a `zz-` prefix so it runs LAST, mirroring the way
// 00-auth.spec.ts is named to run first. This is not cosmetic: a
// *successful* logout deactivates the server-side session that every
// other spec reuses via storageState (.auth/synthetic-state.json).
// selfservice-api#53 added an `IsSessionActive` check to middleware.Auth,
// so once this spec logs out, the shared `session` cookie is dead
// server-side and any spec running afterwards would get a 401 on
// /auth/me and fail. Ordering this check last keeps the suite
// self-contained without needing its own throwaway login.
//
// Regression context (the reason this synthetic exists):
// Clicking "Sign out" appeared to log the user out but immediately
// re-authenticated them. handleLogout() only nulled in-memory
// user/token state and hard-navigated to /login WITHOUT calling the
// backend, so the HttpOnly `session` cookie survived. +layout.ts
// load() then called GET /auth/me (200), re-populated the auth store,
// and the /login guard bounced the user straight back to the dashboard.
//
// Fixed in:
//   - selfservice-api#53  — LogoutHandler now hits Authentik's
//     end_session_endpoint, deactivates the DB session, and clears the
//     cookie; middleware.Auth verifies the session is still active.
//   - selfservice-ui#22   — handleLogout() now POSTs /auth/logout, then
//     does a top-level window.location.assign(logout_url) so the browser
//     actually reaches Authentik's end-session endpoint (a fetch alone
//     can't clear the SSO cookie). Authentik 302s back to /login.

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

test('logout_terminates_session', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Logout terminates session',
		description:
			'Signed-in synthetic user clicks Sign out → UI POSTs /auth/logout (200) → top-level navigation to Authentik end-session → 302 back to /login. Reloading the app root must then keep the user on /login, NOT silently re-authenticate to the dashboard. Regression (selfservice-api#53 / selfservice-ui#22): logout used to leave the session cookie alive so /auth/me returned 200 and the login guard bounced the user back in.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-logout_terminates_session-fails'
	});

	// Start authenticated on the dashboard so we're logging out from a
	// real, established session.
	await page.goto('/');
	await expect(page, 'expected to start authenticated on the dashboard/pods route').toHaveURL(
		/\/(pods|dashboard)?\/?$/,
		{ timeout: 15_000 }
	);

	// The fix has the frontend POST /auth/logout BEFORE it navigates
	// away. Arm the response wait before clicking so we can't miss it in
	// the race against the top-level navigation. Asserting this call was
	// actually made (and returned 200) is the crux of the backend fix —
	// the old code never called the backend at all.
	const logoutRespPromise = page.waitForResponse(
		(r) => /\/auth\/logout(\?|$)/.test(r.url()) && r.request().method() === 'POST',
		{ timeout: 15_000 }
	);

	// Click "Sign out" (rendered with aria-label / title 'Sign out').
	const signOut = page.getByRole('button', { name: /sign out/i });
	await expect(signOut, 'Sign out button should be visible for an authed user').toBeVisible({
		timeout: 15_000
	});
	await signOut.click();

	const logoutResp = await logoutRespPromise;
	expect(logoutResp.status(), 'POST /auth/logout should return 200').toBe(200);

	// After the Authentik end-session round-trip the browser must land
	// back on the app's /login page (post_logout_redirect_uri).
	//
	// NOTE: this leg depends on a MANUAL Authentik step — the
	// `selfservice` OAuth2 provider must list
	// https://crucible.jmal.io/login among its allowed post-logout
	// redirect URIs. Until that is configured, Authentik rejects the
	// post_logout_redirect_uri and the browser is stranded on an
	// Authentik error page, so this wait will time out. That is a real,
	// user-visible failure of the logout flow and is deliberately NOT
	// weakened — see the PR body.
	await page.waitForURL(/\/login(\?|$|\/)/, { timeout: 30_000 });
	await expect(
		page.getByRole('button', { name: /sign in with sso/i }),
		'expected the /login screen (Sign in with SSO) after logout'
	).toBeVisible({ timeout: 15_000 });

	// ── CORE REGRESSION ASSERTION ──────────────────────────────────────
	// Re-load the app root. The whole bug was that this step silently
	// re-authenticated the user back onto the dashboard. The session must
	// now be truly dead, so the login guard must keep us on /login.
	await page.goto('/');
	await expect(
		page,
		'reloading the app root after logout must stay on /login — a bounce back to the dashboard is the exact silent re-auth regression this check guards'
	).toHaveURL(/\/login(\?|$|\/)/, { timeout: 15_000 });
	await expect(
		page.getByRole('button', { name: /sign in with sso/i }),
		'expected to remain logged out (Sign in with SSO visible) after reloading the app root'
	).toBeVisible({ timeout: 15_000 });

	// Belt-and-suspenders on the server-side contract: /auth/me must now
	// be unauthenticated. This proves the DB session was deactivated
	// (selfservice-api#53 IsSessionActive) and the cookie cleared, not
	// merely the in-memory store nulled.
	const meResp = await page.request.get('/auth/me');
	expect(
		meResp.status(),
		`/auth/me must be 401 after logout (server-side session deactivated); got ${meResp.status()}`
	).toBe(401);
});
