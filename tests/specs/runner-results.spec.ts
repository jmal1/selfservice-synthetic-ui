// runner-results.spec.ts — asserts that per-action assessment results render
// in the UI for the most recent completed run.
//
// Uses the instructor/admin account so it can access GET /api/v1/admin/runs
// (student-role would get 403). Once the most recent completed run is located
// by ID, the spec navigates to the student-facing run detail page at
// /pods/{podId}/testing/runs/{runId} — the same page a student sees for
// their own runs.
//
// What this checks:
//   1. GET /api/v1/admin/runs returns a non-empty list (runs exist in prod)
//   2. At least one run has a completed status (not stuck in provisioning)
//   3. The run detail page renders without an error boundary or spinner
//   4. The "Workflow Results" section is present with at least one result
//   5. Expanding a result reveals the action-level results table with rows
//
// Hollowness guard: the spec explicitly FAILs (does NOT skip) if there are no
// runs or no completed runs. An empty list is a production signal, not an
// acceptable configuration gap.

import { adminTest, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const ADMIN_USERNAME = process.env.SYNTHETIC_ADMIN_USERNAME;
adminTest.skip(
	!ADMIN_USERNAME,
	'SYNTHETIC_ADMIN_USERNAME not configured; skipping instructor-role synthetic specs'
);

// Minimal shape of the admin runs list entry. The detail response adds
// `results`, but the list response only needs id / pod_id / status.
interface RunSummary {
	id: string;
	pod_id: string;
	status: string;
	started_at?: string | null;
}

interface ActionResultSummary {
	action: string;
	status: string;
	message?: string | null;
	exit_code: number;
	duration_ms: number;
}

interface WorkflowResultSummary {
	id: string;
	workflow_name: string;
	status: string;
	student_message?: string | null;
	action_results?: ActionResultSummary[];
}

interface PodTestingRunDetail extends RunSummary {
	results?: WorkflowResultSummary[];
}

// Statuses that represent a still-in-progress run.
const ACTIVE_STATUSES = new Set(['pending', 'provisioning', 'running']);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactText = (value: string) => new RegExp(escapeRegex(value));

adminTest('runner_results_render', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Assessment run results render for instructor',
		description:
			'Finds the most recent completed assessment run via GET /api/v1/admin/runs, verifies the ' +
			'pod testing dashboard + history pages, then navigates from /pods/{podId}/testing to the ' +
			'completed run detail and asserts the workflow/action output content visible to a student. ' +
			'Catches broken results rendering, a stalled runner that never writes results back, or a ' +
			'broken dashboard navigation path. Deliberately FAILs (does not skip) if no completed runs ' +
			'exist in production.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-runner_results_render-fails'
	});

	// ── Step 1: get admin runs list via API ────────────────────────────
	// Use page.request so the call carries the admin session cookies.
	await page.goto('/admin/runs');

	const runsResp = await page.request.get('/api/v1/admin/runs', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false
	});
	expect(
		runsResp.status(),
		'GET /api/v1/admin/runs must return 200 — either the admin account lost its role, ' +
			'or the runs API endpoint broke'
	).toBe(200);

	const runs: RunSummary[] = await runsResp.json();
	expect(
		runs.length,
		'GET /api/v1/admin/runs returned an empty list. In production there should always be ' +
			'at least one run. Either no student has ever triggered an assessment ' +
			'(unlikely once deployed), or the runs API is returning an empty response incorrectly.'
	).toBeGreaterThan(0);

	const sorted = [...runs].sort((a, b) => {
		const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
		const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
		return tb - ta;
	});

	const findRetainedTerminalRun = async (runsList: RunSummary[]) => {
		for (const run of [...runsList].sort((a, b) => {
			const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
			const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
			return tb - ta;
		})) {
			if (ACTIVE_STATUSES.has(run.status)) continue;

			const podId = run.pod_id;
			const dashboardResp = await page.request.get(`/api/v1/pods/${podId}/testing`, {
				headers: { accept: 'application/json' },
				failOnStatusCode: false
			});
			if (dashboardResp.status() === 404) continue;
			if (dashboardResp.status() !== 200) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing returned ${dashboardResp.status()} for terminal run ${run.id}; ` +
						`this is not a normal destroyed-pod 404 and should be investigated.`
				);
			}
			const dashboard = await dashboardResp.json();
			if (!Array.isArray(dashboard?.recent_runs)) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing returned a non-array recent_runs payload for terminal run ${run.id}`
				);
			}
			if (!(dashboard.recent_runs as RunSummary[]).some((candidate) => candidate.id === run.id)) {
				continue;
			}

			const historyResp = await page.request.get(`/api/v1/pods/${podId}/testing/runs`, {
				headers: { accept: 'application/json' },
				failOnStatusCode: false
			});
			if (historyResp.status() === 404) continue;
			if (historyResp.status() !== 200) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing/runs returned ${historyResp.status()} for terminal run ${run.id}; ` +
						`this is not a normal destroyed-pod 404 and should be investigated.`
				);
			}
			const history = await historyResp.json();
			if (!Array.isArray(history) || !(history as RunSummary[]).some((candidate) => candidate.id === run.id)) {
				continue;
			}

			const detailResp = await page.request.get(`/api/v1/pods/${podId}/testing/runs/${run.id}`, {
				headers: { accept: 'application/json' },
				failOnStatusCode: false
			});
			if (detailResp.status() === 404) continue;
			if (detailResp.status() !== 200) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing/runs/${run.id} returned ${detailResp.status()}; ` +
						`this is not a normal destroyed-pod 404 and should be investigated.`
				);
			}
			const detail: PodTestingRunDetail = await detailResp.json();
			if (detail.id !== run.id || ACTIVE_STATUSES.has(detail.status)) {
				continue;
			}
			return { podId, run, detail };
		}

		throw new Error(
			`No terminal assessment run remained attached to an active pod dashboard/history/detail flow. ` +
				`Tried ${runsList.length} candidate run(s) from GET /api/v1/admin/runs; each either had pod routes ` +
				`return 404 after completion (destroyed runner-smoke pod) or did not appear in the dashboard/history ` +
				`payloads. Preserve a run whose pod still exists and contains the completed result in the testing UI.`
		);
	};

	const retainedRun = await findRetainedTerminalRun(runs);
	const { podId, run: completedRun, detail } = retainedRun;

	const workflowWithOutput = (detail.results ?? []).find((result) => {
		const studentText = result.student_message?.trim() ?? '';
		if (studentText.length > 0) return true;
		return (result.action_results ?? []).some((action) => (action.message ?? '').trim().length > 0);
	});
	if (!workflowWithOutput) {
		throw new Error(
			`No completed workflow result on ${completedRun.id} has non-empty output. ` +
				`The run is terminal and its pod still exists, but the API returned zero student_message/action.message values. ` +
				`Check the runner worker for empty output content or confirm the wire shape changed.`
		);
	}

	const evidenceAction = (workflowWithOutput.action_results ?? []).find(
		(action) => (action.message ?? '').trim().length > 0
	);
	const evidenceText = (workflowWithOutput.student_message ?? '').trim() || evidenceAction?.message?.trim() || '';
	if (!evidenceText) {
		throw new Error(
			`Workflow ${workflowWithOutput.workflow_name} on ${completedRun.id} has non-empty evidence but no visible text content.`
		);
	}

	// ── Step 2: navigate the real testing dashboard and history pages ───
	await page.goto(`/pods/${podId}/testing`);
	await expect(page, 'testing dashboard route should render after navigation').toHaveURL(
		new RegExp(`^.*\/pods\/${podId}\/testing/?$`),
		{ timeout: 15_000 }
	);
	await expect(
		page.getByRole('heading', { name: 'Assessments' }),
		'Assessments heading must be visible on /pods/{podId}/testing'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole('heading', { name: 'Recent Runs' }),
		'Expected the Recent Runs panel on /pods/{podId}/testing'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole('link', { name: 'View all →' }),
		'Out-of-date dashboard should link to the run history page'
	).toHaveAttribute('href', `/pods/${podId}/testing/runs`);

	await page.getByRole('link', { name: 'View all →' }).click();
	await expect(page, 'run history route should render after clicking View all').toHaveURL(
		new RegExp(`^.*\/pods\/${podId}\/testing\/runs/?$`),
		{ timeout: 15_000 }
	);
	await expect(
		page.getByRole('heading', { name: 'Run History' }),
		'Run History heading must be visible on /pods/{podId}/testing/runs'
	).toBeVisible({ timeout: 15_000 });
	const historyRowLink = page.locator(`a[href="/pods/${podId}/testing/runs/${completedRun.id}"]`).first();
	await expect(
		historyRowLink,
		`Run history table must include the completed run ${completedRun.id}`
	).toBeVisible({ timeout: 15_000 });
	await historyRowLink.click();

	// ── Step 3: assert the result detail page and workflow/action content ─
	await expect(page, 'run detail route should render after history navigation').toHaveURL(
		new RegExp(`^.*\/pods\/${podId}\/testing\/runs\/${completedRun.id}/?$`),
		{ timeout: 15_000 }
	);
	await expect(
		page.getByRole('heading', { name: 'Run Details' }),
		'"Run Details" heading must be visible — if missing, the run detail page is showing ' +
			'a spinner or error boundary instead of the result'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole('heading', { name: 'Workflow Results' }),
		'"Workflow Results" heading must be visible on a completed run detail page'
	).toBeVisible({ timeout: 15_000 });

	const workflowPicker = page
		.locator('button[aria-expanded]')
		.filter({ hasText: workflowWithOutput.workflow_name })
		.first();
	await expect(
		workflowPicker,
		`workflow "${workflowWithOutput.workflow_name}" should be visible on the run detail page`
	).toBeVisible({ timeout: 15_000 });
	await workflowPicker.click();

	const actionTable = page
		.locator('table')
		.filter({ has: page.locator('th', { hasText: 'Action' }) })
		.last();
	await expect(
		actionTable,
		'Action results table must appear after expanding a workflow result. ' +
			'Its absence means result.action_results is null/empty or the expand click failed'
	).toBeVisible({ timeout: 10_000 });

	const actionRows = actionTable.locator('tbody tr');
	const rowCount = await actionRows.count();
	expect(
		rowCount,
		'Action results table must have at least one row — a completed workflow with zero ' +
			'action records is a runner data regression'
	).toBeGreaterThan(0);

	const workflowCard = page
		.locator('section, article, div')
		.filter({
			has: page.locator('button[aria-expanded]').filter({ hasText: workflowWithOutput.workflow_name }).first()
		})
		.first();

	if (workflowWithOutput.student_message?.trim()) {
		await expect(
			workflowCard,
			`Expected workflow "${workflowWithOutput.workflow_name}" to render the exact student message in the expanded card`
		).toContainText(exactText(workflowWithOutput.student_message.trim()));
	} else if (evidenceAction) {
		const actionRow = actionRows
			.filter({
				has: actionTable.locator('td').filter({ hasText: evidenceAction.action })
			})
			.first();
		await expect(
			actionRow,
			`Expected the "${evidenceAction.action}" row to render message "${evidenceAction.message?.trim()}"`
		).toContainText(exactText(evidenceAction.action));
		await expect(
			actionRow.locator('td').nth(3),
			`Expected action "${evidenceAction.action}" to render the exact non-empty action output message`
		).toContainText(exactText(evidenceAction.message!.trim()));
	} else {
		throw new Error(
			`Workflow ${workflowWithOutput.workflow_name} on ${completedRun.id} had no visible message evidence to assert.`
		);
	}
});
