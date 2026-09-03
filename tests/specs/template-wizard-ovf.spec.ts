// template-wizard-ovf.spec.ts — instructor-authenticated Wave B regression guards

import { adminTest, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const ADMIN_USERNAME = process.env.SYNTHETIC_ADMIN_USERNAME;
adminTest.skip(
	!ADMIN_USERNAME,
	'SYNTHETIC_ADMIN_USERNAME not configured; skipping instructor-role synthetic specs'
);

async function openTemplateWizard(page: import('@playwright/test').Page) {
	await page.goto('/admin/templates/new');
	await expect(
		page.getByRole('heading', { name: /New template/i }),
		'"New template" heading must be visible — instructor role check failed or the wizard did not render'
	).toBeVisible({ timeout: 15_000 });
}

adminTest('template_wizard_ovf_option', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'OVF/OVA option present and enabled in template wizard',
		description:
			'Instructor opens /admin/templates/new and asserts the source-type selector offers the ' +
			'OVF/OVA option and remains enabled. Guards the Wave B source_type=ovf authoring path.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-template_wizard_ovf_option-fails'
	});

	await openTemplateWizard(page);

	// This locator intentionally fails if option[value="ovf"] is removed.
	const sourceSelect = page.locator('select:has(option[value="ovf"])');
	await expect(
		sourceSelect,
		'Source-type select must be visible — option[value="ovf"] was not found in the wizard'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		sourceSelect,
		'Source-type select must not be disabled after source data finishes loading'
	).not.toBeDisabled({ timeout: 15_000 });

	const ovfOption = sourceSelect.locator('option[value="ovf"]');
	await expect(
		ovfOption,
		'The OVF source option must have the user-facing OVF/OVA label'
	).toHaveText('OVF/OVA');
});

adminTest(
	'template_wizard_skip_generalize_checkbox',
	async ({ authedAdminPage: page }, testInfo) => {
		meta(testInfo, {
			title: 'Skip generalize control follows supported source types',
			description:
				'Instructor selects OVF/OVA and asserts the skip-generalize checkbox and safety help are ' +
				'visible, then selects ISO and asserts the checkbox is unavailable.',
			severity: 'warning',
			runbook:
				'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-template_wizard_skip_generalize_checkbox-fails'
		});

		await openTemplateWizard(page);

		const sourceSelect = page.locator('select:has(option[value="ovf"])');
		await expect(sourceSelect).not.toBeDisabled({ timeout: 15_000 });
		await sourceSelect.selectOption('ovf');

		const checkbox = page.getByRole('checkbox', {
			name: /Image is already generalized — do not run sysprep\/cloud-init clean/i
		});
		await expect(
			checkbox,
			'OVF/OVA sources must expose the skip-generalize checkbox'
		).toBeVisible();
		await expect(
			page.getByText(/Skips GuestOps generalize only \(sysprep \/ cloud-init clean\)\./i),
			'Help text must limit the bypass to GuestOps generalize'
		).toBeVisible();
		await expect(
			page.getByText(/Verify still runs/i),
			'Help text must state that verify still runs'
		).toBeVisible();

		await sourceSelect.selectOption('iso');
		await expect(
			checkbox,
			'ISO sources must not expose skip_generalize because the API rejects that combination'
		).not.toBeVisible();
	}
);
