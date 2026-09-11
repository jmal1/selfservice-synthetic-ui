// student-guide.spec.ts — verifies students can use the public guide while
// instructor-only wiki material remains unavailable to their session.

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

test(
	'student_guide_navigation_and_connection_render',
	async ({ authedPage: page }, testInfo) => {
		meta(testInfo, {
			title: 'Student Guide navigation and connection instructions render',
			description:
				'Student-role synthetic user opens /pods, uses the Student Guide sidebar link, and verifies ' +
				'the Student Guide hub and Connecting to Your VM guide render. It also confirms the student ' +
				'guide index API is available to the authenticated student session.',
			severity: 'warning',
			runbook:
				'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-student_guide_navigation_and_connection_render-fails'
		});

		const podsResponse = await page.goto('/pods', { waitUntil: 'domcontentloaded' });
		const podsStatus = podsResponse?.status() ?? 200;
		expect(podsStatus, `GET /pods returned ${podsStatus}`).toBeLessThan(500);

		const guideLink = page.getByRole('link', { name: 'Student Guide', exact: true });
		await expect(
			guideLink,
			'Student Guide sidebar navigation must be visible to a student'
		).toBeVisible({ timeout: 15_000 });

		await guideLink.click();
		await expect(page, 'Student Guide sidebar link must open the guide hub').toHaveURL(
			/\/guide(?:[?#].*)?$/,
			{ timeout: 15_000 }
		);
		await expect(
			page.getByRole('heading', { name: 'Student Guide', exact: true, level: 1 }),
			'Student Guide hub h1 must render after navigation'
		).toBeVisible({ timeout: 15_000 });

		const connectionLink = page.getByRole('link', { name: /connecting to your vm/i });
		await expect(
			connectionLink,
			'Student Guide hub must link to the Connecting to Your VM instructions'
		).toBeVisible({ timeout: 15_000 });

		await connectionLink.click();
		await expect(
			page,
			'Connection guide navigation must stay within /guide, including query-string deep links'
		).toHaveURL(/\/guide(?:[/?#]|$)/, { timeout: 15_000 });
		await expect(
			page.getByRole('heading', { name: /connecting to your vm/i }),
			'Connecting to Your VM guide heading must render after navigation'
		).toBeVisible({ timeout: 15_000 });

		const studentGuideIndex = await page.request.get('/api/v1/student-guide/index', {
			headers: { accept: 'application/json' },
			failOnStatusCode: false
		});
		expect(
			studentGuideIndex.status(),
			`GET /api/v1/student-guide/index returned ${studentGuideIndex.status()} for a student session`
		).toBe(200);
	}
);

test('student_wiki_index_is_forbidden', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Student cannot access instructor wiki index',
		description:
			'Student-role synthetic user directly requests the instructor-only /api/v1/wiki/index endpoint ' +
			'with its real session cookies. The API must return 401 or 403, never instructor material or a 5xx.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-student_wiki_index_is_forbidden-fails'
	});

	const wikiIndex = await page.request.get('/api/v1/wiki/index', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false
	});
	const status = wikiIndex.status();

	expect(
		status,
		`GET /api/v1/wiki/index returned ${status} for a student session; instructor wiki must not fail with 5xx`
	).toBeLessThan(500);
	expect(
		[401, 403],
		`GET /api/v1/wiki/index returned ${status} for a student session; instructor wiki material must be denied`
	).toContain(status);
});
