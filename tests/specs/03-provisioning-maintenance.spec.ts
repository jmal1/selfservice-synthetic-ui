import { test, expect } from '../lib/fixtures.ts';
import { syntheticConfig } from '../lib/config.ts';
import {
	AVAILABLE_MESSAGE,
	expectControlsUnavailableOrDisabled,
	MAINTENANCE_MESSAGE,
	parsePodSummaries,
	recordMaintenanceLimitation
} from '../lib/maintenance.ts';
import { meta } from '../lib/synthetic.ts';

const maintenanceBanner = (page: import('@playwright/test').Page) =>
	page.locator('aside[role="alert"][aria-labelledby="provisioning-maintenance-title"]');

test.skip(
	syntheticConfig.lifecycleEnabled && !syntheticConfig.expectMaintenance,
	'SYNTHETIC_LIFECYCLE_ENABLED=true; provisioning contract not registered in lifecycle mode'
);

test('provisioning_maintenance_contract', async ({ authedPage: page }, testInfo) => {
	const expectMaintenance = syntheticConfig.expectMaintenance;

	meta(testInfo, {
		title: expectMaintenance
			? 'Provisioning maintenance controls are safe'
			: 'Open provisioning contract is healthy',
		description: expectMaintenance
			? 'Authenticates as the synthetic student, verifies the exact provisioning status API and ' +
				'maintenance message, and proves pod creation, blueprint deployment, and add-VM controls ' +
				'are disabled or unavailable without invoking any mutation. When an existing cleanup-eligible ' +
				'pod is present, also proves Delete Pod remains enabled.'
			: 'Authenticates as the synthetic student, verifies provisioning status reports enabled with the ' +
				'available message, confirms maintenance UI is absent, and proves pod-create, blueprint-deploy, ' +
				'and add-VM wizards reach enabled final actions without invoking any mutation.',
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
		expectMaintenance
			? 'maintenance status must match the coordinated API contract exactly'
			: 'open provisioning status must match the coordinated API contract exactly'
	).toEqual(
		expectMaintenance
			? { enabled: false, message: MAINTENANCE_MESSAGE }
			: { enabled: true, message: AVAILABLE_MESSAGE }
	);

	await page.goto('/');
	if (expectMaintenance) {
		const dashboardBanner = maintenanceBanner(page);
		await expect(
			dashboardBanner,
			'semantic provisioning maintenance alert must be visible'
		).toBeVisible({
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
	} else {
		await expect(
			maintenanceBanner(page),
			'maintenance alert must not mount when provisioning is open'
		).toHaveCount(0);
		await expect(
			page.getByRole('link', { name: 'Deploy VM', exact: true }).first(),
			'dashboard must expose an actionable Deploy VM entry when provisioning is open'
		).toBeVisible({ timeout: 15_000 });
	}

	const dashboardProvisioningControls = page
		.getByRole('link', { name: /deploy vm|create pod|new environment/i })
		.or(page.getByRole('button', { name: /deploy vm|create pod|new environment/i }));
	if (expectMaintenance) {
		await expectControlsUnavailableOrDisabled(
			dashboardProvisioningControls,
			'dashboard pod-create controls'
		);
	} else {
		await expect(
			dashboardProvisioningControls.first(),
			'dashboard pod-create controls must be actionable when provisioning is open'
		).toBeVisible({ timeout: 15_000 });
	}

	// Walk the custom-environment wizard to its final action without submitting.
	await page.goto('/pods/new');
	if (expectMaintenance) {
		await expect(
			maintenanceBanner(page),
			'maintenance alert must remain visible on the provisioning route'
		).toBeVisible({ timeout: 15_000 });
	} else {
		await expect(
			maintenanceBanner(page),
			'maintenance alert must not mount on the provisioning route when open'
		).toHaveCount(0);
	}
	await page.getByRole('button', { name: /^next$/i }).click();
	await page.getByRole('button', { name: /custom environment/i }).click();
	await page.getByRole('button', { name: /^next$/i }).click();
	await page
		.getByLabel(/environment name/i)
		.fill(`${expectMaintenance ? 'maintenance' : 'open'}-create-${Date.now()}`);
	await page.getByRole('button', { name: /^next$/i }).click();
	const customTemplate = page.getByRole('button', { name: 'Increase quantity', exact: true }).first();
	await expect(
		customTemplate,
		'custom provisioning wizard must expose at least one template'
	).toBeVisible({ timeout: 15_000 });
	await customTemplate.click();
	await page.getByRole('button', { name: /^next$/i }).click();
	await page.getByRole('button', { name: /^next$/i }).click();
	const deployEnvironment = page.getByRole('button', { name: /^deploy environment$/i });
	if (expectMaintenance) {
		await expect(
			deployEnvironment,
			'final pod-create action must be natively disabled during maintenance'
		).toBeDisabled();
	} else {
		await expect(
			deployEnvironment,
			'final pod-create action must be enabled when provisioning is open'
		).toBeEnabled();
	}

	// Walk the blueprint wizard independently so the final button, rather than
	// the harmless mode selector with the same name, is what we assert.
	await page.goto('/pods/new');
	await page.getByRole('button', { name: /^next$/i }).click();
	await page.getByRole('button', { name: /deploy blueprint/i }).click();
	await page.getByRole('button', { name: /^next$/i }).click();
	const blueprintChoices = page.locator('button').filter({ has: page.locator('h3') });
	await expect(
		blueprintChoices.first(),
		'blueprint provisioning wizard must expose at least one active blueprint'
	).toBeVisible({ timeout: 15_000 });
	await blueprintChoices.first().click();
	await page.getByRole('button', { name: /^next$/i }).click();
	await page
		.getByLabel(/environment name/i)
		.fill(`${expectMaintenance ? 'maintenance' : 'open'}-blueprint-${Date.now()}`);
	await page.getByRole('button', { name: /^next$/i }).click();
	const deployBlueprint = page.getByRole('button', { name: /^deploy blueprint$/i });
	if (expectMaintenance) {
		await expect(
			deployBlueprint,
			'final blueprint-deploy action must be natively disabled during maintenance'
		).toBeDisabled();
	} else {
		await expect(
			deployBlueprint,
			'final blueprint-deploy action must be enabled when provisioning is open'
		).toBeEnabled();
	}

	expect(
		mutationRequests,
		`wizard inspection must not invoke provisioning mutations: ${mutationRequests.join(', ')}`
	).toEqual([]);

	const podsResponse = await page.request.get('/api/v1/pods', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false
	});
	expect(
		podsResponse.status(),
		expectMaintenance
			? 'GET /api/v1/pods must remain readable during maintenance'
			: 'GET /api/v1/pods must remain readable when provisioning is open'
	).toBe(200);
	const pods = parsePodSummaries(await podsResponse.json());
	const addVmPod = pods.find((pod) =>
		['active', 'provisioning'].includes(pod.status?.toLowerCase() ?? '')
	);
	const cleanupPod = pods.find(
		(pod) => !['destroying', 'deleting', 'deleted'].includes(pod.status?.toLowerCase() ?? '')
	);

	if (addVmPod) {
		await page.goto(`/pods/${addVmPod.id}`);
		const addVmLink = page.getByRole('link', { name: /^add vm$/i });
		if (expectMaintenance) {
			await expect(
				addVmLink,
				'existing-pod Add VM entry must be aria-disabled during maintenance'
			).toHaveAttribute('aria-disabled', 'true');
		} else {
			await expect(
				addVmLink,
				'existing-pod Add VM entry must be actionable when provisioning is open'
			).not.toHaveAttribute('aria-disabled', 'true');
		}

		await page.goto(`/pods/new?pod=${encodeURIComponent(addVmPod.id)}`);
		if (expectMaintenance) {
			await expect(
				maintenanceBanner(page),
				'maintenance alert must remain visible on the add-VM route'
			).toBeVisible({ timeout: 15_000 });
		} else {
			await expect(
				maintenanceBanner(page),
				'maintenance alert must not mount on the add-VM route when open'
			).toHaveCount(0);
		}
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
		const addVms = page.getByRole('button', { name: /^add vms$/i });
		if (expectMaintenance) {
			await expect(
				addVms,
				'final add-VM action must be natively disabled during maintenance'
			).toBeDisabled();
		} else {
			await expect(
				addVms,
				'final add-VM action must be enabled when provisioning is open'
			).toBeEnabled();
		}
	} else {
		recordMaintenanceLimitation(
			testInfo,
			expectMaintenance
				? 'No active/provisioning pod existed, so this run could not enter the add-VM wizard. ' +
						'No pod was created because lifecycle mutations are forbidden during maintenance.'
				: 'No active/provisioning pod existed, so this run could not enter the add-VM wizard. ' +
						'No pod was created because lifecycle mutations remain disabled for this suite.'
		);
	}

	if (cleanupPod && expectMaintenance) {
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
	} else if (!cleanupPod && expectMaintenance) {
		recordMaintenanceLimitation(
			testInfo,
			'No cleanup-eligible pod existed, so this run could not assert Delete Pod or Delete VM. ' +
				'The check does not create a fixture because lifecycle mutations are forbidden.'
		);
	}

	expect(
		mutationRequests,
		`provisioning contract check must not invoke provisioning mutations: ${mutationRequests.join(', ')}`
	).toEqual([]);
});
