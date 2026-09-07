// Wave C — instructor workflow/action authoring surfaces.
//
// Positive instructor coverage (student RBAC for /admin/workflows is already
// in admin-routes-403.spec.ts). The create check stays draft-only: never
// Submit / Approve / Activate, and always DELETE via the admin API.

import { type APIRequestContext } from '@playwright/test';
import { adminTest, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const ADMIN_USERNAME = process.env.SYNTHETIC_ADMIN_USERNAME;
adminTest.skip(
	!ADMIN_USERNAME,
	'SYNTHETIC_ADMIN_USERNAME not configured; skipping instructor-role synthetic specs'
);

type WorkflowRow = {
	id: string;
	name: string;
	slug: string;
	status?: string;
};

async function listWorkflows(request: APIRequestContext): Promise<WorkflowRow[]> {
	const resp = await request.get('/api/v1/admin/workflows', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false
	});
	expect(resp.status(), 'GET /api/v1/admin/workflows must succeed for instructor').toBe(200);
	const body = await resp.json();
	return Array.isArray(body) ? body : [];
}

async function deleteWorkflow(request: APIRequestContext, id: string): Promise<void> {
	const resp = await request.delete(`/api/v1/admin/workflows/${id}`, {
		headers: { accept: 'application/json' },
		failOnStatusCode: false
	});
	expect(
		[200, 204, 404].includes(resp.status()),
		`DELETE /api/v1/admin/workflows/${id} must succeed or already be gone (got ${resp.status()})`
	).toBe(true);
}

adminTest('workflows_page_loads', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Workflows admin page loads for instructor',
		description:
			'Instructor opens /admin/workflows and sees the Workflows heading plus the + New Workflow ' +
			'control. Proves the authoring list surface mounts for an authorized instructor.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-workflows_page_loads-fails'
	});

	await page.goto('/admin/workflows');
	await expect(
		page.getByRole('heading', { name: 'Workflows', exact: true }),
		'Workflows heading must be visible — redirected or error boundary otherwise'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole('button', { name: '+ New Workflow' }).first(),
		'+ New Workflow must be visible so instructors can enter create mode'
	).toBeVisible({ timeout: 10_000 });
});

adminTest('actions_page_loads', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Action library page loads for instructor',
		description:
			'Instructor opens /admin/actions and sees the Action Library heading plus + New Action. ' +
			'Proves the library authoring surface mounts for an authorized instructor.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-actions_page_loads-fails'
	});

	await page.goto('/admin/actions');
	await expect(
		page.getByRole('heading', { name: 'Action Library', exact: true }),
		'Action Library heading must be visible — redirected or error boundary otherwise'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole('button', { name: '+ New Action' }),
		'+ New Action must be visible so instructors can enter create mode'
	).toBeVisible({ timeout: 10_000 });
});

adminTest(
	'workflow_draft_create_edit_cleanup',
	async ({ authedAdminPage: page }, testInfo) => {
		meta(testInfo, {
			title: 'Instructor can create a draft workflow then delete it',
			description:
				'Instructor creates a unique draft via the Workflows wizard (metadata → add one library ' +
				'action → Create Workflow / Save as Draft), confirms it appears in the list as draft, ' +
				'then deletes it via the admin API. Never Submit/Approve/Activate.',
			severity: 'warning',
			runbook:
				'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-workflow_draft_create_edit_cleanup-fails'
		});

		const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const name = `Wave C Synth ${suffix}`;
		const slug = `wave-c-synth-${suffix}`;

		let workflowId = '';
		try {
			await page.goto('/admin/workflows');
			await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible({
				timeout: 15_000
			});
			await page.getByRole('button', { name: '+ New Workflow' }).first().click();
			await expect(page.getByRole('heading', { name: 'New Workflow' })).toBeVisible({
				timeout: 15_000
			});

			await page.locator('label').filter({ hasText: /^Name/ }).locator('input').fill(name);
			const slugInput = page.locator('label').filter({ hasText: /^Slug/ }).locator('input');
			await slugInput.fill(slug);
			await page.getByRole('button', { name: 'Next →' }).click();

			await expect(
				page.getByRole('heading', { name: 'Available Actions' }),
				'Step 2 must show the library action picker'
			).toBeVisible({ timeout: 15_000 });
			const addButtons = page.getByRole('button', { name: '+ Add' });
			await expect(
				addButtons.first(),
				'Library must contain at least one action to compose into the draft'
			).toBeVisible({ timeout: 15_000 });
			await addButtons.first().click();
			await page.getByRole('button', { name: 'Next →' }).click();

			const saveBtn = page
				.getByRole('button', { name: 'Create Workflow' })
				.or(page.getByRole('button', { name: 'Save as Draft' }));
			await expect(saveBtn).toBeVisible({ timeout: 15_000 });
			await saveBtn.click();

			await expect(
				page.getByRole('heading', { name: 'Workflows', exact: true }),
				'Successful create must return to the workflows list'
			).toBeVisible({ timeout: 15_000 });

			const row = page.locator('tr', { hasText: slug });
			await expect(row, `draft slug ${slug} must appear in the workflows table`).toBeVisible({
				timeout: 15_000
			});

			const rows = await listWorkflows(page.request);
			const created = rows.find((wf) => wf.slug === slug);
			expect(created, 'created workflow must be returned by the admin list API').toBeTruthy();
			workflowId = created!.id;
			expect(created!.status ?? 'draft').toBe('draft');
		} finally {
			if (workflowId) {
				await deleteWorkflow(page.request, workflowId);
			} else {
				const leftover = (await listWorkflows(page.request)).find((wf) => wf.slug === slug);
				if (leftover) await deleteWorkflow(page.request, leftover.id);
			}
		}
	}
);
