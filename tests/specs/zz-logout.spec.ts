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
//     can't clear the SSO cookie). Authentik ends the session.
//
// Two real-world wrinkles this spec accounts for (both discovered by
// running it against the live env):
//   1. SvelteKit hydration race — the Sign out button is server-rendered
//      and visible before its onclick handler attaches, so an early click
//      is a silent no-op. We retry the click until the backend call fires.
//   2. Authentik's invalidation flow shows a "You've logged out"
//      confirmation page instead of auto-redirecting to /login, so we
//      assert the security invariant (app session is dead → re-entering
//      forces /login) rather than a specific post-logout URL.

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

test('logout_terminates_session', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Logout terminates session',
		description:
			'Signed-in synthetic user clicks Sign out → UI POSTs /auth/logout (200) → top-level navigation to Authentik end-session, terminating the SSO session. The core assertion: re-entering the app root afterwards forces /login (Sign in with SSO) and /auth/me returns 401 — the user is NOT silently re-authenticated onto the dashboard. Regression (selfservice-api#53 / selfservice-ui#22): logout used to leave the session cookie alive so /auth/me returned 200 and the login guard bounced the user back in. (Authentik shows a logout confirmation interstitial rather than auto-redirecting to /login; that UX is intentionally not asserted here.)',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-logout_terminates_session-fails'
	});

	// Start authenticated on the dashboard so we're logging out from a
	// real, established session. Wait for networkidle so the initial
	// dashboard data burst (/auth/me + /api/v1/pods + /api/v1/jobs) has
	// settled before we try to interact.
	await page.goto('/', { waitUntil: 'networkidle' });
	await expect(page, 'expected to start authenticated on the dashboard/pods route').toHaveURL(
		/\/(pods|dashboard)?\/?$/,
		{ timeout: 15_000 }
	);

	// The "Sign out" button (aria-label / title 'Sign out') is
	// server-rendered and visible BEFORE its Svelte onclick handler is
	// attached during hydration, so a click fired too early is silently a
	// no-op. Defeat that hydration race by retrying the click until the
	// backend logout call actually fires. handleLogout() POSTs
	// /auth/logout before it navigates, so observing that request is our
	// signal the handler ran — and asserting it returned 200 is the crux
	// of the backend fix (the old code never called the backend at all).
	const signOut = page.getByRole('button', { name: /sign out/i });
	await expect(signOut, 'Sign out button should be visible for an authed user').toBeVisible({
		timeout: 15_000
	});

	let logoutResp: Awaited<ReturnType<typeof page.waitForResponse>> | undefined;
	await expect(async () => {
		const respPromise = page.waitForResponse(
			(r) => /\/auth\/logout(\?|$)/.test(r.url()) && r.request().method() === 'POST',
			{ timeout: 3_000 }
		);
		// The element detaches once a successful click triggers the
		// top-level navigation; swallow the resulting click error and let
		// the captured response (if any) decide success.
		await signOut.click({ timeout: 3_000 }).catch(() => {});
		logoutResp = await respPromise;
	}).toPass({ timeout: 30_000 });

	expect(logoutResp!.status(), 'POST /auth/logout should return 200').toBe(200);

	// The 200 body carries the Authentik end-session URL and the app does
	// a top-level navigation to it, terminating the provider (SSO)
	// session. We wait for that hop to reach Authentik so we know the
	// SSO round-trip actually happened.
	//
	// NOTE — why we do NOT assert an automatic bounce back to /login:
	// Authentik's `default-provider-invalidation-flow` renders a
	// "You've logged out of Self-Service Portal" confirmation page
	// (with Go back / Log out of jmal.io / Log back in buttons) instead
	// of auto-302-ing to `post_logout_redirect_uri`. The redirect URI is
	// whitelisted, but the flow still stops on that interstitial by
	// design, so waiting for /login here would hang. Asserting on
	// Authentik's logout-flow UX is both brittle and beside the point —
	// the security-critical invariant is that the app session is now
	// dead, which we prove below by re-entering the app. See the PR body
	// for the Authentik-flow follow-up if an automatic return to /login
	// is desired.
	await page.waitForURL(
		new RegExp((process.env.SYNTHETIC_IDP_HOST ?? 'auth.example.test').replace(/\./g, '\\.')),
		{ timeout: 30_000 }
	).catch(() => {});

	// ── CORE REGRESSION ASSERTION ──────────────────────────────────────
	// Re-enter the app from scratch. The whole bug was that this step
	// silently re-authenticated the user back onto the dashboard because
	// the session cookie survived and /auth/me still returned 200. The
	// session must now be truly dead, so the app's guard must force us to
	// /login and must NOT show the dashboard.
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
