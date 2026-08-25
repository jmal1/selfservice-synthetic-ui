import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const WARNING_TITLE = 'School-safe Internet filtering is not currently active';
const WARNING_BODY = 'Outbound browsing from this lab may reach unrestricted Internet content.';

test('student_internet_filtering_warning_visible', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Student Internet filtering warning is visible',
		description:
			'Student-role synthetic user opens the pod creation route through Caddy, Authentik, and the UI, then verifies the temporary unrestricted-Internet warning is exposed as an accessible alert.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Student-Content-Filtering.md#monitoring-and-tests'
	});

	const response = await page.goto('/pods/new', { waitUntil: 'domcontentloaded' });
	const status = response?.status() ?? 200;
	expect(status, `GET /pods/new returned ${status}`).toBeLessThan(500);

	const warning = page.getByRole('alert', { name: WARNING_TITLE, exact: true });
	await expect(
		warning,
		'pod creation must disclose the temporary student Internet filtering gap'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		warning.getByText(WARNING_BODY, { exact: true }),
		'filtering warning must explain that outbound browsing may be unrestricted'
	).toBeVisible();
});
