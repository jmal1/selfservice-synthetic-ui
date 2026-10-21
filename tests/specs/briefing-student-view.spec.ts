// briefing-student-view.spec.ts — the synthetic student sees a published lab
// briefing on its pod page and in the standalone /briefing/<pod> view.
//
// Fixture: selfservice-api deploy/sql/synthetic-briefing.sql publishes a fixed
// briefing ("Synthetic fixture briefing") on the internal synthetic-noop
// template, which backs the student's persistent ui-runner-results-fixture pod.
// Real students cannot use synthetic-noop, so the fixture is invisible to them.
//
// READ-ONLY: it never edits, saves or publishes anything.
//
// What breaks it:
//   - GET /api/v1/pods/{id}/briefing regresses (no sections for the owner)
//   - The Briefing card is removed from /pods/[id] or crashes
//   - /briefing/[podId] is missing, shows the sidebar, or loses the Copy button
//   - The fixture briefing was unpublished or the fixture pod was destroyed

import { expect, test } from '../lib/fixtures.ts';
import { parsePodSummaries } from '../lib/maintenance.ts';
import { meta } from '../lib/synthetic.ts';

const FIXTURE_HEADING = 'Synthetic fixture briefing';

test('briefing_student_view', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Student sees the lab briefing',
		description:
			'The synthetic student finds its pod with a published briefing, sees the Briefing card on ' +
			'/pods/<id>, and opens the standalone /briefing/<id> page (no sidebar, Copy button on code). ' +
			'A failure means students cannot read lab briefings after provisioning.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-briefing_student_view-fails'
	});

	const podsResp = await page.request.get('/api/v1/pods', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false,
		timeout: 15_000
	});
	expect(podsResp.status(), 'GET /api/v1/pods must return 200 for the student session').toBe(200);

	let podId: string | undefined;
	for (const pod of parsePodSummaries(await podsResp.json()).slice(0, 25)) {
		const resp = await page.request.get(`/api/v1/pods/${pod.id}/briefing`, {
			headers: { accept: 'application/json' },
			failOnStatusCode: false,
			timeout: 15_000
		});
		expect(resp.status(), `GET /api/v1/pods/${pod.id}/briefing must return 200 to the owner`).toBe(200);
		const body = (await resp.json()) as { sections?: { body_md?: string }[] };
		if ((body.sections ?? []).some((s) => s.body_md?.includes(FIXTURE_HEADING))) {
			podId = pod.id;
			break;
		}
	}
	expect(
		podId,
		'No student pod has the fixture briefing. Apply selfservice-api deploy/sql/synthetic-briefing.sql ' +
			'and check that the ui-runner-results-fixture pod (synthetic-noop) still exists.'
	).toBeTruthy();

	await page.goto(`/pods/${podId}`);
	const card = page.getByRole('region', { name: 'Briefing' });
	await expect(card, 'the Briefing card must render on the pod page').toBeVisible({ timeout: 20_000 });
	await expect(card.getByRole('heading', { name: FIXTURE_HEADING })).toBeVisible();
	const newTab = card.getByRole('link', { name: 'Open in new tab' });
	await expect(newTab).toHaveAttribute('href', `/briefing/${podId}`);
	await expect(card.getByRole('button', { name: 'Open in new window' })).toBeVisible();

	await page.goto(`/briefing/${podId}`);
	await expect(page.getByRole('heading', { name: FIXTURE_HEADING })).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole('heading', { level: 1, name: /Briefing$/ })).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Copy code to clipboard' }),
		'fenced code in a briefing must get a Copy button'
	).toBeVisible();
	await expect(
		page.getByRole('link', { name: 'New environment', exact: true }),
		'the standalone briefing page must not render the sidebar'
	).toHaveCount(0);
});
