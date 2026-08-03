// admin-routes-403.spec.ts — synthetic user has student role, so admin
// pages MUST never return admin data. The strongest assertion is on the
// API gate: when an admin page loads, its data-loading API call must
// return 403. The UI shell may still render (separate todo
// ui-admin-route-clientside-gate), but the API contract is what
// actually protects sensitive data, so that is what we assert on.
//
// This catches the original regression (admin API returning 500 instead
// of 403 after a routing change) AND any regression where the admin
// API stops gating role.

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

interface AdminCheck {
	path: string;
	description: string;
	// One or more regex patterns that match the API endpoint the page
	// fetches on load. We only need ONE matching response to be 403 for
	// the gate to be considered working.
	apiPatterns: RegExp[];
	// The endpoint we call DIRECTLY with the student session. This is the
	// real security boundary — see the probe at the bottom of the test.
	apiPath: string;
}

const ADMIN_CHECKS: AdminCheck[] = [
	{
		path: '/admin/workflows',
		description: 'Workflow definitions admin page',
		apiPatterns: [/\/api\/v1\/admin\/workflows(\?|$)/],
		apiPath: '/api/v1/admin/workflows'
	},
	{
		path: '/admin/templates',
		description: 'Template management admin page',
		apiPatterns: [/\/api\/v1\/admin\/templates(\?|$)/],
		apiPath: '/api/v1/admin/templates'
	},
	{
		path: '/admin/jobs',
		description: 'Background job queue admin page',
		apiPatterns: [/\/api\/v1\/admin\/jobs(\?|$)/],
		apiPath: '/api/v1/admin/jobs'
	},
	{
		path: '/admin/audit',
		description: 'Audit log admin page',
		apiPatterns: [/\/api\/v1\/admin\/audit(\?|$)/],
		apiPath: '/api/v1/admin/audit'
	},
	{
		path: '/admin/users',
		description: 'User management admin page',
		apiPatterns: [/\/api\/v1\/admin\/users(\?|$)/],
		apiPath: '/api/v1/admin/users'
	},
	{
		// The image-upload endpoints hand out presigned MinIO URLs. If a
		// student could reach them they could write arbitrary objects into
		// the staging bucket and have them imported onto the vCenter ISO
		// datastore, so this gate matters more than most.
		path: '/admin/images',
		description: 'VM image upload/library admin page',
		apiPatterns: [/\/api\/v1\/admin\/images(\?|\/|$)/],
		apiPath: '/api/v1/admin/images'
	}
];

for (const { path, description, apiPatterns, apiPath } of ADMIN_CHECKS) {
	test(`admin_route_protected_${path.replace(/\//g, '_').replace(/^_/, '')}`, async ({
		authedPage: page
	}, testInfo) => {
		meta(testInfo, {
			title: `RBAC: student blocked from ${path}`,
			description: `Student-role synthetic user visits ${path} (${description}), then calls ${apiPath} directly with its real session cookies. That endpoint MUST return 401/403 (never 200, never 5xx). The direct call is the meaningful assertion: a client-side redirect away from the admin page proves nothing to anyone holding a session cookie and curl.`,
			severity: 'warning',
			runbook:
				'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-admin_route_protected-fails'
		});

		// Collect every admin-API response triggered by this navigation.
		const adminResponses: Array<{ url: string; status: number }> = [];
		page.on('response', (resp) => {
			const url = resp.url();
			if (apiPatterns.some((re) => re.test(url))) {
				adminResponses.push({ url, status: resp.status() });
			}
		});

		const response = await page.goto(path, { waitUntil: 'domcontentloaded' });

		// 5xx on the page itself is always a regression.
		const status = response?.status() ?? 200;
		expect(status, `page load returned ${status}`).toBeLessThan(500);

		// Wait for the admin API call to fire (max 5s). Some pages may
		// fire multiple admin calls; we just need at least one.
		try {
			await page.waitForResponse(
				(r) => apiPatterns.some((re) => re.test(r.url())),
				{ timeout: 5000 }
			);
		} catch {
			// Acceptable IF the page redirected away before firing any
			// admin API call (e.g., a future client-side gate redirects
			// to /pods). Fall through to the assertions below.
		}

		// If the page redirected to a non-admin route, the client-side gate
		// worked without ever fetching admin data. That is good UX, but it
		// is NOT proof that the server is protecting anything — so we no
		// longer return early here. See the direct API probe below.
		const currentUrl = page.url();
		const redirectedAway =
			!currentUrl.includes('/admin/') ||
			currentUrl.includes('/login') ||
			currentUrl.endsWith('/pods');

		// Inspect whatever admin API calls the navigation did trigger.
		// FAIL condition: any admin API call returned 200 (data leaked).
		for (const r of adminResponses) {
			expect(
				[401, 403],
				`admin API call ${r.url} returned ${r.status} (expected 401/403). Student role MUST NOT receive admin data.`
			).toContain(r.status);
		}

		// ── The actual security boundary ────────────────────────────────
		// A client-side gate now redirects students away before the page
		// fires any admin request, so the loop above frequently inspects an
		// EMPTY list and passes vacuously. That silently hollowed out this
		// entire check: it would stay green even if the API stopped gating
		// role altogether.
		//
		// So call the endpoint directly, using the student's real session
		// cookies. A redirect in the browser proves nothing to an attacker
		// holding a session token and curl.
		const apiResp = await page.request.get(apiPath, {
			headers: { accept: 'application/json' },
			failOnStatusCode: false
		});
		expect(
			[401, 403],
			`GET ${apiPath} returned ${apiResp.status()} for a student session (expected 401/403). ` +
				`The client-side redirect to "${currentUrl}" is cosmetic — anyone with a session cookie ` +
				'can call this endpoint directly, so the server MUST reject it.'
		).toContain(apiResp.status());

		// Record which layers are actually enforcing, so a future reader can
		// tell a real pass from a cosmetic one.
		testInfo.annotations.push({
			type: 'rbac-enforcement',
			description: `client-side redirect: ${redirectedAway}; api status: ${apiResp.status()}`
		});
	});
}

