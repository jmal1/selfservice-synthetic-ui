// single-vm-entry.spec.ts — the two create paths stay distinct.
//
// Sidebar "New environment" opens a Single VM. My Labs "New lab" opens the
// isolated-lab wizard. The synthetic student is granted labs_enabled so both
// controls are present; ordinary students do not see New lab.

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

test('single_vm_and_lab_entries', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Single VM and isolated lab create entries stay distinct',
		description:
			'The signed-in synthetic student sees sidebar New environment linking to /single-vm/new, ' +
			'the Single VM page heading, and a My Labs New lab link to /deploy. Catches the regression ' +
			'where My Labs was pointed at the Single VM wizard and isolated labs could no longer be created.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-single_vm_and_lab_entries-fails'
	});

	await page.goto('/');
	const environment = page.getByRole('link', { name: 'New environment', exact: true }).first();
	await expect(environment, 'sidebar must offer New environment').toBeVisible({ timeout: 20_000 });
	await expect(environment).toHaveAttribute('href', '/single-vm/new');

	await page.getByRole('link', { name: 'Single VM', exact: true }).first().click();
	await expect(page).toHaveURL(/\/single-vm\/?$/, { timeout: 15_000 });
	await expect(page.getByRole('heading', { name: 'Single VM', exact: true })).toBeVisible();

	await page.goto('/pods');
	const lab = page.getByRole('link', { name: 'New lab', exact: true }).first();
	await expect(lab, 'My Labs must offer New lab for a labs-granted student').toBeVisible({
		timeout: 20_000
	});
	await expect(lab).toHaveAttribute('href', '/deploy');
});
