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
		title: 'Imported OVA option present and enabled in template wizard',
		description:
			'Instructor opens /admin/templates/new and asserts the source-type selector offers the ' +
			'Imported OVA option (value=ovf) and remains enabled. Upload is .ova only; this label must ' +
			'not say OVF.',
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
		'The ovf source option must be labeled Imported OVA — bare .ovf uploads are not supported'
	).toHaveText('Imported OVA');
});

adminTest(
	'template_wizard_skip_generalize_checkbox',
	async ({ authedAdminPage: page }, testInfo) => {
		meta(testInfo, {
			title: 'Skip generalize control follows supported source types',
			description:
				'Instructor selects Imported OVA and asserts the skip-generalize checkbox and safety help are ' +
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
			name: /Prepared appliance — skip sysprep\/cloud-init clean/i
		});
		await expect(
			checkbox,
			'Imported OVA sources must expose the skip-generalize checkbox'
		).toBeVisible();
		await expect(
			checkbox,
			'Prepared OVA appliances default skip_generalize on so GuestOps clean is not run'
		).toBeChecked();
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

adminTest('template_wizard_ova_catalog_picker', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Imported OVA picker uses the catalog, not folder VMs',
		description:
			'Instructor selects Imported OVA and sees either the empty-state Images link or a catalog ' +
			'select with Refresh OVAs. In-flight/error rows are disabled; imported rows carry a moref. ' +
			'An empty catalog is a closed assertion (empty-state + Images link), not a silent skip.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-template_wizard_ova_catalog_picker-fails'
	});

	await openTemplateWizard(page);

	const sourceSelect = page.locator('select:has(option[value="ovf"])');
	await expect(sourceSelect).not.toBeDisabled({ timeout: 15_000 });
	await sourceSelect.selectOption('ovf');

	// Wait out the Loading OVAs… branch before branching empty vs catalog.
	await expect(page.getByText('Loading OVAs…')).toHaveCount(0, { timeout: 15_000 });

	const emptyState = page.getByText('No imported OVAs found');
	const catalogSelect = page.getByTestId('ovf-ova-select');
	const imagesLink = page.getByRole('link', { name: /Images page/i });
	// Prefer visible text: buttons sit inside a <label>, so role-name matching can
	// become the whole field label ("Imported OVA…") instead of "Refresh OVAs".
	const refresh = page.getByRole('button').filter({ hasText: /^Refresh OVAs$/ });
	const loadError = page.getByText("Couldn't load OVAs");

	await expect(
		emptyState.or(catalogSelect).or(loadError),
		'OVA source must settle into empty-state, catalog select, or load-error'
	).toBeVisible({ timeout: 15_000 });

	if (await loadError.isVisible().catch(() => false)) {
		await expect(page.getByRole('button').filter({ hasText: /^Retry$/ })).toBeVisible();
		return;
	}

	if (await emptyState.isVisible().catch(() => false)) {
		await expect(
			imagesLink,
			'Empty OVA catalog must send the instructor to /admin/images instead of claiming there are no OVAs forever'
		).toBeVisible();
		await expect(refresh, 'Empty OVA catalog should offer Refresh OVAs').toBeVisible();
		return;
	}

	await expect(
		catalogSelect,
		'OVA catalog select must render when any catalog row exists (imported, importing, or error)'
	).toBeVisible({ timeout: 10_000 });
	await expect(refresh, 'OVA picker must have a refresh control like the ISO picker').toBeVisible();

	const options = catalogSelect.locator('option');
	const count = await options.count();
	expect(count, 'catalog select must include the placeholder plus at least one OVA row').toBeGreaterThan(1);

	for (let i = 1; i < count; i++) {
		const opt = options.nth(i);
		const disabled = await opt.isDisabled();
		const text = (await opt.textContent()) ?? '';
		if (disabled) {
			expect(
				text,
				'disabled catalog rows must show importing or failed import copy'
			).toMatch(/⏳|⚠|Importing|failed|still being/i);
		} else {
			expect(text, 'selectable imported OVAs must show the vCenter moref').toMatch(/vm-/i);
		}
	}
});
