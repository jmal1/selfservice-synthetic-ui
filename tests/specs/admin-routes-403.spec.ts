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
}

const ADMIN_CHECKS: AdminCheck[] = [
	{
		path: '/admin/workflows',
		description: 'Workflow definitions admin page',
		apiPatterns: [/\/api\/v1\/admin\/workflows(\?|$)/]
	},
	{
		path: '/admin/templates',
		description: 'Template management admin page',
		apiPatterns: [/\/api\/v1\/admin\/templates(\?|$)/]
	},
	{
		path: '/admin/jobs',
		description: 'Background job queue admin page',
		apiPatterns: [/\/api\/v1\/admin\/jobs(\?|$)/]
	},
	{
		path: '/admin/audit',
		description: 'Audit log admin page',
		apiPatterns: [/\/api\/v1\/admin\/audit(\?|$)/]
	},
	{
		path: '/admin/users',
		description: 'User management admin page',
		apiPatterns: [/\/api\/v1\/admin\/users(\?|$)/]
	}
];

for (const { path, description, apiPatterns } of ADMIN_CHECKS) {
	test(`admin_route_protected_${path.replace(/\//g, '_').replace(/^_/, '')}`, async ({
		authedPage: page
	}, testInfo) => {
		meta(testInfo, {
			title: `RBAC: student blocked from ${path}`,
			description: `Student-role synthetic user visits ${path} (${description}). The corresponding admin API endpoint MUST return 403 (never 200, never 5xx). The UI shell may render — that is tracked separately — but the API gate is the real security boundary.`,
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

		// If the page redirected to a non-admin route, the gate worked
		// without ever fetching admin data — that's a pass.
		const currentUrl = page.url();
		const redirectedAway =
			!currentUrl.includes('/admin/') ||
			currentUrl.includes('/login') ||
			currentUrl.endsWith('/pods');

		if (redirectedAway) {
			return;
		}

		// Otherwise, we MUST see an admin API response, and every one
		// we saw must be 403 (or 401). Any 200 means admin data leaked
		// to a student.
		expect(
			adminResponses.length,
			`expected at least one admin API call matching ${apiPatterns.map((r) => r.source).join(', ')}, got none. URL=${currentUrl}`
		).toBeGreaterThan(0);

		for (const r of adminResponses) {
			expect(
				[401, 403],
				`admin API call ${r.url} returned ${r.status} (expected 401/403). Student role MUST NOT receive admin data.`
			).toContain(r.status);
		}
	});
}

