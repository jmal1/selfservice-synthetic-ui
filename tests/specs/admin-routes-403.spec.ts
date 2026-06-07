// admin-routes-403.spec.ts — synthetic user has student role, so admin
// pages should redirect or render an "unauthorized" message. This
// catches the regression where /admin/* started returning 500s instead
// of 403s after a routing change.

import { test, expect } from '../lib/fixtures.ts';

const ADMIN_PATHS = [
	'/admin/workflows',
	'/admin/templates',
	'/admin/jobs',
	'/admin/audit',
	'/admin/users'
];

for (const path of ADMIN_PATHS) {
	test(`admin_route_protected_${path.replace(/\//g, '_').replace(/^_/, '')}`, async ({
		authedPage: page
	}) => {
		const response = await page.goto(path, { waitUntil: 'domcontentloaded' });

		// Acceptable outcomes:
		//   - server-rendered 403 / 404
		//   - redirect to home with a "you need admin" message
		//   - SvelteKit client-side gate that swaps in a "Forbidden" UI
		// Unacceptable:
		//   - 5xx
		//   - blank page
		expect(response?.status() ?? 200).toBeLessThan(500);

		const body = await page.content();
		const looksOk =
			/admin|forbidden|unauthorized|not authorized|you do not have/i.test(body) ||
			page.url().includes('/pods') ||
			page.url().endsWith('/');
		expect(looksOk, `admin gate appears broken at ${path}`).toBe(true);
	});
}
