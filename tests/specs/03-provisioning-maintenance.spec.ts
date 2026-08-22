import { test, expect } from '../lib/fixtures.ts';
import { syntheticConfig } from '../lib/config.ts';
import {
	expectControlsUnavailableOrDisabled,
	MAINTENANCE_MESSAGE,
	parsePodSummaries,
	recordMaintenanceLimitation
} from '../lib/maintenance.ts';
import { meta } from '../lib/synthetic.ts';

test.skip(
	!syntheticConfig.expectMaintenance,
	'SYNTHETIC_EXPECT_MAINTENANCE is false; maintenance UI contract is not expected'
);

test('provisioning_maintenance_contract', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Provisioning maintenance controls are safe',
		description:
			'Authenticates as the synthetic student, verifies the exact provisioning status API and ' +
			'maintenance message, and proves pod creation, blueprint deployment, and add-VM controls ' +
			'are disabled or unavailable without invoking any mutation. When an existing cleanup-eligible ' +
			'pod is present, also proves Delete Pod remains enabled.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-provisioning_maintenance_contract-fails'
	});

	const mutationRequests: string[] = [];
	await page.route(/\/api\/v1\/(?:pods|blueprints)(?:\/|$)/, async (route) => {
		const request = route.request();
		if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
			await route.continue();
			return;
		}

		mutationRequests.push(`${request.method()} ${request.url()}`);
		await route.abort('blockedbyclient');
	});

	const statusResponse = await page.request.get('/api/v1/provisioning/status', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false
	});
	expect(
		statusResponse.status(),
		'authenticated GET /api/v1/provisioning/status must return 200'
	).toBe(200);
	expect(
		await statusResponse.json(),
		'maintenance status must match the coordinated API contract exactly'
	).toEqual({ enabled: false, message: MAINTENANCE_MESSAGE });

	await page.goto('/');
	const dashboardBanner = page.locator(
		'aside[role="alert"][aria-labelledby="provisioning-maintenance-title"]'
	);
	await expect(dashboardBanner, 'semantic provisioning maintenance alert must be visible').toBeVisible({
		timeout: 15_000
	});
	await expect(
		dashboardBanner.locator('#provisioning-maintenance-title'),
		'maintenance alert must have the stable accessible title'
	).toHaveText('New deployments are paused');
	await expect(
		dashboardBanner.getByText(MAINTENANCE_MESSAGE, { exact: true }),
		'maintenance alert must show the API-provided message'
	).toBeVisible();
	await expect(
		dashboardBanner.getByRole('button', {
			name: 'Check provisioning availability again',
			exact: true
		})
	).toBeVisible();

	const dashboardProvisioningControls = page
		.getByRole('link', { name: /deploy vm|create pod|new environment/i })
		.or(page.getByRole('button', { name: /deploy vm|create pod|new environment/i }));
	await expectControlsUnavailableOrDisabled(
		dashboardProvisioningControls,
		'dashboard pod-create controls'
	);

	// Walk the custom-environment wizard to its final action without submitting.
	await page.goto('/pods/new');
	await expect(
		page.locator('aside[role="alert"][aria-labelledby="provisioning-maintenance-title"]'),
		'maintenance alert must remain visible on the provisioning route'
	).toBeVisible({ timeout: 15_000 });
	await page.getByRole('button', { name: /^next$/i }).click();
	await page.getByRole('button', { name: /custom environment/i }).click();
	await page.getByRole('button', { name: /^next$/i }).click();
	await page.getByLabel(/environment name/i).fill(`maintenance-create-${Date.now()}`);
	await page.getByRole('button', { name: /^next$/i }).click();
	const customTemplate = page.getByRole('button', { name: 'Increase quantity', exact: true }).first();
	await expect(
		customTemplate,
		'custom provisioning wizard must expose at least one template'
	).toBeVisible({ timeout: 15_000 });
	await customTemplate.click();
	await page.getByRole('button', { name: /^next$/i }).click();
	await page.getByRole('button', { name: /^next$/i }).click();
	await expect(
		page.getByRole('button', { name: /^deploy environment$/i }),
		'final pod-create action must be natively disabled during maintenance'
	).toBeDisabled();

	// Walk the blueprint wizard independently so the final button, rather than
	// the harmless mode selector with the same name, is what we assert.
	await page.goto('/pods/new');
	await page.getByRole('button', { name: /^next$/i }).click();
	await page.getByRole('button', { name: /deploy blueprint/i }).click();
	await page.getByRole('button', { name: /^next$/i }).click();
	const blueprintChoices = page
		.locator('button')
		.filter({ has: page.locator('h3') });
	await expect(
		blueprintChoices.first(),
		'blueprint provisioning wizard must expose at least one active blueprint'
	).toBeVisible({ timeout: 15_000 });
	await blueprintChoices.first().click();
	await page.getByRole('button', { name: /^next$/i }).click();
	await page.getByLabel(/environment name/i).fill(`maintenance-blueprint-${Date.now()}`);
	await page.getByRole('button', { name: /^next$/i }).click();
	await expect(
		page.getByRole('button', { name: /^deploy blueprint$/i }),
		'final blueprint-deploy action must be natively disabled during maintenance'
	).toBeDisabled();

	expect(
		mutationRequests,
		`wizard inspection must not invoke provisioning mutations: ${mutationRequests.join(', ')}`
	).toEqual([]);

	const podsResponse = await page.request.get('/api/v1/pods', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false
	});
	expect(podsResponse.status(), 'GET /api/v1/pods must remain readable during maintenance').toBe(200);
	const pods = parsePodSummaries(await podsResponse.json());
	const addVmPod = pods.find((pod) =>
		['active', 'provisioning'].includes(pod.status?.toLowerCase() ?? '')
	);
	const cleanupPod = pods.find(
		(pod) => !['destroying', 'deleting', 'deleted'].includes(pod.status?.toLowerCase() ?? '')
	);

	if (addVmPod) {
		await page.goto(`/pods/${addVmPod.id}`);
		await expect(
			page.getByRole('link', { name: /^add vm$/i }),
			'existing-pod Add VM entry must be aria-disabled during maintenance'
		).toHaveAttribute('aria-disabled', 'true');

		await page.goto(`/pods/new?pod=${encodeURIComponent(addVmPod.id)}`);
		await expect(
			page.locator('aside[role="alert"][aria-labelledby="provisioning-maintenance-title"]'),
			'maintenance alert must remain visible on the add-VM route'
		).toBeVisible({ timeout: 15_000 });
		const addVmTemplate = page
			.getByRole('button', { name: 'Increase quantity', exact: true })
			.first();
		await expect(
			addVmTemplate,
			'add-VM wizard must expose at least one template'
		).toBeVisible({ timeout: 15_000 });
		await addVmTemplate.click();
		await page.getByRole('button', { name: /^next$/i }).click();
		await page.getByRole('button', { name: /^next$/i }).click();
		await expect(
			page.getByRole('button', { name: /^add vms$/i }),
			'final add-VM action must be natively disabled during maintenance'
		).toBeDisabled();
	} else {
		recordMaintenanceLimitation(
			testInfo,
			'No active/provisioning pod existed, so this run could not enter the add-VM wizard. ' +
				'No pod was created because lifecycle mutations are forbidden during maintenance.'
		);
	}

	if (cleanupPod) {
		await page.goto(`/pods/${cleanupPod.id}`);
		const deletePod = page.getByRole('button', { name: /^delete pod$/i });
		await expect(
			deletePod,
			'Delete Pod must remain available for cleanup during provisioning maintenance'
		).toBeVisible({ timeout: 15_000 });
		await expect(
			deletePod,
			'Delete Pod must not be globally disabled during provisioning maintenance'
		).toBeEnabled();

		const deleteVmControls = page.getByRole('button', { name: /^delete vm$/i });
		let visibleDeleteVmControls = 0;
		for (let index = 0; index < (await deleteVmControls.count()); index += 1) {
			const deleteVm = deleteVmControls.nth(index);
			if (!(await deleteVm.isVisible())) continue;
			visibleDeleteVmControls += 1;
			await expect(
				deleteVm,
				'Delete VM must not be globally disabled during provisioning maintenance'
			).toBeEnabled();
		}
		if ((await deleteVmControls.count()) > 0) {
			expect(
				visibleDeleteVmControls,
				'at least one Delete VM control must be visible when VM cleanup controls exist'
			).toBeGreaterThan(0);
		}
	} else {
		recordMaintenanceLimitation(
			testInfo,
			'No cleanup-eligible pod existed, so this run could not assert Delete Pod or Delete VM. ' +
				'The check does not create a fixture because lifecycle mutations are forbidden.'
		);
	}

	expect(
		mutationRequests,
		`maintenance check must not invoke provisioning mutations: ${mutationRequests.join(', ')}`
	).toEqual([]);
});
