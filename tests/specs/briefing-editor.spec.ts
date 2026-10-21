// briefing-editor.spec.ts — instructor-authenticated check that the lab
// briefing editor renders end-to-end for a real template.
//
// READ-ONLY by design: it never saves, publishes or restores. Briefing
// revisions are immutable and published ones reach students, so a monitor
// must not write them.
//
// What this checks:
//   1. /admin/templates lists at least one template with a Briefing link
//   2. The editor page renders: "Briefing — <name>" heading, the Head chip,
//      the Monaco editor, the Preview region and the History heading
//   3. Every briefing API call the page makes returns 200 (meta + history,
//      plus the head revision when one exists)
//
// What breaks it:
//   - The /admin/templates/{id}/briefing route is missing or crashes
//   - Monaco fails to lazy-load (the page falls back to a textarea)
//   - The /api/v1/admin/templates/{id}/briefing* API regresses (403/404/500)

import { adminTest, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const ADMIN_USERNAME = process.env.SYNTHETIC_ADMIN_USERNAME;
adminTest.skip(
	!ADMIN_USERNAME,
	'SYNTHETIC_ADMIN_USERNAME not configured; skipping instructor-role synthetic specs'
);

adminTest('briefing_editor_loads', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Briefing editor loads for instructor',
		description:
			'Instructor opens /admin/templates, follows the first Briefing link, and the lab briefing ' +
			'editor renders with its Monaco editor, preview, revision status and history, while every ' +
			'briefing API call returns 200. Read-only: it never saves or publishes. A failure means ' +
			'instructors cannot write or review lab briefings.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-briefing_editor_loads-fails'
	});

	const briefingResponses: { url: string; status: number }[] = [];
	page.on('response', (res) => {
		if (/\/api\/v1\/admin\/templates\/[^/]+\/briefing/.test(res.url())) {
			briefingResponses.push({ url: res.url(), status: res.status() });
		}
	});

	await page.goto('/admin/templates');
	const link = page.locator('a[href^="/admin/templates/"][href$="/briefing"]').first();
	await expect(
		link,
		'Each template row must have a Briefing link — its absence means the link was removed ' +
			'or no templates are listed for the instructor'
	).toBeVisible({ timeout: 15_000 });
	await link.click();

	await expect(
		page.getByRole('heading', { name: /^Briefing — / }),
		'"Briefing — <template>" heading must render — if missing, the route crashed or redirected'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByText(/^Head: /),
		'Head revision chip must render — it only appears after the briefing meta API answered'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.locator('.monaco-editor').first(),
		'Monaco editor must load — a missing editor means the lazy Monaco bundle failed'
	).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
	await expect(page.getByText('Could not load the briefing')).toHaveCount(0);

	expect(
		briefingResponses.length,
		'the editor must call the briefing meta and history APIs'
	).toBeGreaterThanOrEqual(2);
	for (const r of briefingResponses) {
		expect(r.status, `briefing API ${r.url} must return 200`).toBe(200);
	}
});
