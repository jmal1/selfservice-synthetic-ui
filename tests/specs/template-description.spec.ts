// template-description.spec.ts — template descriptions are instructor-editable
// Markdown (jmal1/Crucible#76): instructors see them in the admin edit row,
// students see them rendered on /templates.
//
// Fixture: the internal synthetic-noop template's description starts with
// FIXTURE_MARKDOWN. It was set once through the admin editor; real students
// cannot see synthetic-noop, so the fixture is invisible to them.
//
// READ-ONLY: the instructor check opens Edit and Preview, then cancels. It
// never saves, because a description change reaches students immediately.
//
// What breaks it:
//   - The description field disappears from the admin edit row
//   - Descriptions render as plain text again (literal ** shown to students)
//   - renderBriefing strips ordinary Markdown
//   - Someone edited synthetic-noop's description and dropped the fixture

import { adminTest, expect, test } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const TEMPLATE = process.env.SYNTHETIC_TEMPLATE_NAME?.trim() || 'synthetic-noop';
const FIXTURE_TEXT = 'Synthetic fixture description';
const FIXTURE_MARKDOWN = `**${FIXTURE_TEXT}**`;
const RUNBOOK = 'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md';

test('template_description_student_view', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Student sees template description as Markdown',
		description:
			`The synthetic student opens /templates and the ${TEMPLATE} card renders its fixture ` +
			'description as sanitized Markdown (bold text, no literal asterisks). A failure means ' +
			'students see raw Markdown or no description before they provision.',
		severity: 'warning',
		runbook: `${RUNBOOK}#when-template_description_student_view-fails`
	});

	await page.goto('/templates');
	const card = page
		.locator('div.panel')
		.filter({ has: page.getByRole('heading', { name: new RegExp(`^${TEMPLATE}$`, 'i') }) });
	await expect(card, `template "${TEMPLATE}" card must be visible to the synthetic student`).toBeVisible({
		timeout: 15_000
	});
	const desc = card.locator('.template-description');
	await expect(
		desc.locator('strong', { hasText: FIXTURE_TEXT }),
		'fixture description must render as Markdown — missing <strong> means plain-text rendering or a lost fixture'
	).toBeVisible();
	await expect(desc, 'raw Markdown must not reach students').not.toContainText('**');
});

adminTest.describe('instructor', () => {
	adminTest.skip(
		!process.env.SYNTHETIC_ADMIN_USERNAME,
		'SYNTHETIC_ADMIN_USERNAME not configured; skipping instructor-role synthetic specs'
	);

	adminTest('template_description_editor', async ({ authedAdminPage: page }, testInfo) => {
		meta(testInfo, {
			title: 'Template description editor loads for instructor',
			description:
				`Instructor opens /admin/templates, clicks Edit on ${TEMPLATE}, and the description field ` +
				'shows the stored Markdown and previews it rendered. Read-only: it cancels without saving. ' +
				'A failure means instructors cannot edit what students see before they provision.',
			severity: 'warning',
			runbook: `${RUNBOOK}#when-template_description_editor-fails`
		});

		await page.goto('/admin/templates');
		const row = page
			.locator('tbody tr')
			// The name cell can carry badges ("Single VM only"), so match its prefix.
			.filter({ has: page.getByRole('cell', { name: new RegExp(`^${TEMPLATE}\\b`, 'i') }) });
		await expect(row, `admin row for "${TEMPLATE}" must be listed`).toBeVisible({ timeout: 15_000 });
		await row.getByRole('button', { name: 'Edit', exact: true }).click();

		const field = page.locator('tbody textarea');
		await expect(field, 'Edit must show the description field').toBeVisible();
		await expect(field, 'description field must hold the stored fixture').toHaveValue(
			new RegExp(FIXTURE_MARKDOWN.replace(/\*/g, '\\*'))
		);
		await page.locator('tbody').getByRole('button', { name: 'Preview', exact: true }).click();
		await expect(page.locator('tbody strong', { hasText: FIXTURE_TEXT })).toBeVisible();
		await page.locator('tbody').getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(page.locator('tbody textarea')).toHaveCount(0);
	});
});
