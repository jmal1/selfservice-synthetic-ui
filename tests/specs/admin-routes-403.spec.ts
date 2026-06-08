// admin-routes-403.spec.ts — synthetic user has student role, so admin
// pages should redirect or render an "unauthorized" message. This
// catches the regression where /admin/* started returning 500s instead
// of 403s after a routing change.

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const ADMIN_PATHS = [
	'/admin/workflows',
	'/admin/templates',
	'/admin/jobs',
	'/admin/audit',
	'/admin/users'
];

const PATH_DESC: Record<string, string> = {
	'/admin/workflows': 'Workflow definitions admin page',
	'/admin/templates': 'Template management admin page',
	'/admin/jobs': 'Background job queue admin page',
	'/admin/audit': 'Audit log admin page',
	'/admin/users': 'User management admin page'
};

for (const path of ADMIN_PATHS) {
	test(`admin_route_protected_${path.replace(/\//g, '_').replace(/^_/, '')}`, async ({
		authedPage: page
	}, testInfo) => {
		meta(testInfo, {
			title: `RBAC: student blocked from ${path}`,
			description: `Student-role synthetic user visits ${path} (${PATH_DESC[path]}) and should be denied gracefully (3xx/4xx + clear UI), never 5xx and never a blank page. Catches the regression where admin pages started returning 500 instead of 403 after a routing change.`,
			severity: 'warning',
			runbook:
				'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-admin_route_protected-fails'
		});
		const response = await page.goto(path, { waitUntil: 'domcontentloaded' });

		// Acceptable outcomes:
		//   - server-rendered 403 / 404
		//   - redirect to home with a "you need admin" message
		//   - SvelteKit client-side gate that swaps in a "Forbidden" UI
		//   - UI shell renders BUT the data-loading API call returned
		//     403, surfaced as a visible "Failed to load" alert (this
		//     proves the API gate is working even if the UI shell isn't
		//     gated client-side — tracked separately as
		//     ui-admin-route-clientside-gate)
		// Unacceptable:
		//   - 5xx
		//   - blank page (no alert, no shell, no redirect)
		expect(response?.status() ?? 200).toBeLessThan(500);

		const body = await page.content();
		const looksOk =
			/forbidden|unauthorized|not authorized|you do not have|failed to load/i.test(body) ||
			page.url().includes('/pods') ||
			page.url().endsWith('/') ||
			page.url().endsWith('/login');
		expect(looksOk, `admin gate appears broken at ${path}`).toBe(true);
	});
}
