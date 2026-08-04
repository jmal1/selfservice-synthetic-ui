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

// Statuses that represent a still-in-progress run.
const ACTIVE_STATUSES = new Set(['pending', 'provisioning', 'running']);

adminTest('runner_results_render', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Assessment run results render for instructor',
		description:
			'Finds the most recent completed assessment run via GET /api/v1/admin/runs, navigates to ' +
			'its detail page at /pods/{podId}/testing/runs/{runId}, and asserts that Workflow Results ' +
			'render with per-action content. Catches broken results rendering, a stalled runner that ' +
			'never writes results back, or an error boundary on the run detail page. Deliberately ' +
			'FAILs (does not skip) if no completed runs exist in production.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-runner_results_render-fails'
	});

	// ── Step 1: get admin runs list via API ────────────────────────────
	// Use page.request so the call carries the admin session cookies.
	// Navigate to a real page first so the base URL and cookies are set.
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

	// Explicit failure (not skip) for empty list: no runs in production means
	// either the runs API is broken or no student has ever triggered an assessment.
	expect(
		runs.length,
		'GET /api/v1/admin/runs returned an empty list. In production there should always be ' +
			'at least one run. Either no student has ever triggered an assessment ' +
			'(unlikely once deployed), or the runs API is returning an empty response incorrectly.'
	).toBeGreaterThan(0);

	// Sort by started_at descending to find the most recently started run.
	const sorted = [...runs].sort((a, b) => {
		const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
		const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
		return tb - ta;
	});

	// Find the most recent completed run. We want a terminal status because
	// an in-progress run will have no results yet.
	const completedRun = sorted.find((r) => !ACTIVE_STATUSES.has(r.status));
	if (!completedRun) {
		throw new Error(
			`No completed assessment runs found. All ${runs.length} run(s) are still in an active state ` +
				`(${[...ACTIVE_STATUSES].join('/')}). Wait for at least one run to reach a terminal state ` +
				`before this check can pass. If runs are permanently stuck, check the assessment runner worker.`
		);
	}

	// ── Step 2: navigate to run detail page ────────────────────────────
	await page.goto(`/pods/${completedRun.pod_id}/testing/runs/${completedRun.id}`);

	// The "Run Details" heading is the first thing rendered after hydration.
	// A spinner (LoadingSkeleton) or error card means the page is broken.
	await expect(
		page.getByRole('heading', { name: 'Run Details' }),
		'"Run Details" heading must be visible — if missing, the run detail page is showing ' +
			'a spinner or error boundary instead of the result'
	).toBeVisible({ timeout: 15_000 });

	// ── Step 3: assert Workflow Results section ─────────────────────────
	// The "Workflow Results" <section> and its <h2> only render when
	// run.results && run.results.length > 0. A completed run with zero
	// results is itself a regression.
	const resultsHeading = page.getByRole('heading', { name: 'Workflow Results' });
	await expect(
		resultsHeading,
		'"Workflow Results" heading must be visible on a completed run. Its absence means ' +
			'the run completed but has no result records — the runner may not be writing ' +
			'results back to the API'
	).toBeVisible({ timeout: 15_000 });

	// Get the workflow result buttons (each result is rendered as a clickable
	// button inside a card). Guard against an empty list before acting on it.
	const workflowSection = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Workflow Results' }) });

	const workflowButtons = workflowSection.getByRole('button');
	const workflowCount = await workflowButtons.count();
	expect(
		workflowCount,
		'Workflow Results section must contain at least one expandable result card'
	).toBeGreaterThan(0);

	// ── Step 4: expand first result, assert action table ───────────────
	// Click the first workflow card to expand it. The expanded view renders a
	// <table> with Action / Status / Duration / Message columns.
	await workflowButtons.first().click();

	// The action-results table only renders after expansion and only when
	// result.action_results is populated. Locate it by its "Action" column header.
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
});
