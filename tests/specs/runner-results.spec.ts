// runner-results.spec.ts — asserts that per-action assessment results render
// in the student-owned pod testing UI for a retained completed run.
//
// Uses the ordinary synthetic student session and the normal /api/v1/pods
// listing so the test only inspects pods visible to that student. The
// instructor/admin account is intentionally not used because it cannot see a
// student's pod testing routes and cannot be assumed to own the retained run.
//
// What this checks:
//   1. GET /api/v1/pods returns a visible pod list for the student
//   2. A terminal run remains attached to a still-active student pod
//   3. The pod testing dashboard and run detail pages render without errors
//   4. The "Workflow Results" section shows retained student-visible output
//      (student_message, and action rows only when the API returns them)
//
// Hollowness guard: the spec explicitly FAILs (does NOT skip) if there are no
// student-visible terminal runs or no retained student_message / action text.
// Note: the student testing API strips action_results; student_message alone is
// sufficient evidence against that live contract.

import { expect, test } from '../lib/fixtures.ts';
import { parsePodSummaries } from '../lib/maintenance.ts';
import { meta } from '../lib/synthetic.ts';

interface RunSummary {
	id: string;
	pod_id?: string;
	status?: string;
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

const ACTIVE_STATUSES = new Set(['pending', 'provisioning', 'running']);

test('runner_results_render', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Student-owned assessment run results render',
		description:
			'Finds a terminal assessment run attached to the logged-in synthetic student\'s own pods via ' +
			'GET /api/v1/pods, verifies the pod testing dashboard + history pages, then navigates to the ' +
			'completed run detail and asserts the workflow/action output content visible to the student. ' +
			'Catches broken results rendering, a stalled runner that never writes results back, or a ' +
			'broken dashboard navigation path. Deliberately FAILs (does not skip) if no retained student-owned ' +
			'run exists in production.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-runner_results_render-fails'
	});

	const podsResp = await page.request.get('/api/v1/pods', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false,
		timeout: 15_000
	});
	expect(
		podsResp.status(),
		'GET /api/v1/pods must return 200 for the authenticated student session'
	).toBe(200);

	const studentPods = parsePodSummaries(await podsResp.json()).slice(0, 25);
	expect(
		studentPods.length,
		'GET /api/v1/pods returned zero student-visible pods; production should keep at least one active pod for the student synthetic.'
	).toBeGreaterThan(0);

	const findRetainedTerminalRun = async (pods: Array<{ id: string }>) => {
		const candidateRuns: Array<{ podId: string; run: RunSummary }> = [];
		for (const pod of pods) {
			const podId = pod.id;
			const dashboardResp = await page.request.get(`/api/v1/pods/${podId}/testing`, {
				headers: { accept: 'application/json' },
				failOnStatusCode: false,
				timeout: 15_000
			});
			if (dashboardResp.status() === 404) continue;
			if (dashboardResp.status() !== 200) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing returned ${dashboardResp.status()} for a student-owned pod. ` +
						`This is not a normal destroyed-pod 404 and should be investigated.`
				);
			}
			const dashboard = await dashboardResp.json();
			// API encodes a nil Go slice as JSON null (GetRecentRunsForPod with
			// zero rows). UI already uses `recent_runs ?? []`; treat null the
			// same and keep scanning other student pods for a retained run.
			const recentRuns = dashboard?.recent_runs ?? [];
			if (!Array.isArray(recentRuns)) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing returned a non-array recent_runs payload for a student-owned pod`
				);
			}
			for (const candidate of (recentRuns as RunSummary[]).slice(0, 25)) {
				if (!candidate?.id || ACTIVE_STATUSES.has((candidate.status ?? '').toLowerCase())) continue;
				candidateRuns.push({ podId, run: candidate });
				if (candidateRuns.length >= 25) break;
			}
			if (candidateRuns.length >= 25) break;
		}

		let triedCount = 0;
		for (const { podId, run } of candidateRuns.slice(0, 25)) {
			triedCount += 1;
			const historyResp = await page.request.get(`/api/v1/pods/${podId}/testing/runs`, {
				headers: { accept: 'application/json' },
				failOnStatusCode: false,
				timeout: 15_000
			});
			if (historyResp.status() === 404) continue;
			if (historyResp.status() !== 200) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing/runs returned ${historyResp.status()} for student-owned run ${run.id}; ` +
						`this is not a normal destroyed-pod 404 and should be investigated.`
				);
			}
			const history = await historyResp.json();
			if (!Array.isArray(history) || !(history as RunSummary[]).some((candidate) => candidate.id === run.id)) {
				continue;
			}

			const detailResp = await page.request.get(`/api/v1/pods/${podId}/testing/runs/${run.id}`, {
				headers: { accept: 'application/json' },
				failOnStatusCode: false,
				timeout: 15_000
			});
			if (detailResp.status() === 404) continue;
			if (detailResp.status() !== 200) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing/runs/${run.id} returned ${detailResp.status()} for the student-owned pod; ` +
						`this is not a normal destroyed-pod 404 and should be investigated.`
				);
			}
			const detail: PodTestingRunDetail = await detailResp.json();
			if (detail.id !== run.id || ACTIVE_STATUSES.has((detail.status ?? '').toLowerCase())) {
				continue;
			}

			const workflowWithOutput = (detail.results ?? []).find((result) => {
				const actionResults = result.action_results ?? [];
				const hasActionResults = actionResults.length > 0;
				const hasStudentText = (result.student_message ?? '').trim().length > 0;
				const hasActionMessage = actionResults.some((action) => (action.message ?? '').trim().length > 0);
				// Student GET /pods/{id}/testing/runs/{runId} deliberately strips
				// action_results (selfservice-api handlers/testing.go). Student-visible
				// retained output is therefore student_message and/or any action rows
				// the API still returns. Do not require action_results when a non-empty
				// student_message is present — that was an impossible hollowness guard
				// against the live student API contract.
				return hasStudentText || (hasActionResults && hasActionMessage);
			});
			if (!workflowWithOutput) continue;

			const evidenceAction = (workflowWithOutput.action_results ?? []).find(
				(action) => (action.message ?? '').trim().length > 0
			);
			const evidenceText =
				(workflowWithOutput.student_message ?? '').trim() || evidenceAction?.message?.trim() || '';
			if (!evidenceText) continue;

			return { podId, run, workflowWithOutput, evidenceAction, evidenceText, triedCount };
		}

		throw new Error(
			`No terminal assessment run with actionable student-visible workflow output remained attached to a student-visible pod after inspecting ` +
				`${triedCount}/${candidateRuns.length} candidate runs from the first ${studentPods.length} student-owned pods. ` +
				`Each candidate either had pod routes return 404 after completion (destroyed smoke pod), it was still active, or it ` +
				`did not retain non-empty student_message (or action message when action_results are returned) in the testing API.`
		);
	};

	const retainedRun = await findRetainedTerminalRun(studentPods);
	const { podId, run: completedRun, workflowWithOutput, evidenceAction, evidenceText } = retainedRun;
	if (!workflowWithOutput || !evidenceText) {
		throw new Error(
			`No completed workflow result on ${completedRun.id} retains non-empty student_message ` +
				`(or action message when action_results are present). The run is terminal and the pod is still visible to the student, ` +
				`but the API returned no actionable workflow output to render in the testing dashboard/detail UI.`
		);
	}

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

	await expect(page, 'run detail route should render after history navigation').toHaveURL(
		new RegExp(`^.*\/pods\/${podId}\/testing\/runs\/${completedRun.id}/?$`),
		{ timeout: 15_000 }
	);
	await expect(
		page.getByRole('heading', { name: 'Run Details' }),
		'"Run Details" heading must be visible — if missing, the run detail page is showing a spinner or error boundary instead of the result'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole('heading', { name: 'Workflow Results' }),
		'"Workflow Results" heading must be visible on a completed run detail page'
	).toBeVisible({ timeout: 15_000 });

	const workflowPicker = page
		.locator('button[aria-expanded]')
		.filter({ has: page.getByText(workflowWithOutput.workflow_name, { exact: true }) })
		.first();
	await expect(
		workflowPicker,
		`workflow "${workflowWithOutput.workflow_name}" should be visible on the run detail page`
	).toBeVisible({ timeout: 15_000 });
	await workflowPicker.click();

	const actionResults = workflowWithOutput.action_results ?? [];
	if (actionResults.length > 0) {
		const actionTable = page
			.locator('table')
			.filter({ has: page.locator('th', { hasText: 'Action' }) })
			.last();
		await expect(
			actionTable,
			'Action results table must appear after expanding a workflow result when the API returned action_results'
		).toBeVisible({ timeout: 10_000 });

		const actionRows = actionTable.locator('tbody tr');
		const rowCount = await actionRows.count();
		expect(
			rowCount,
			'Action results table must have at least one row — a completed workflow with zero action records is a runner data regression'
		).toBeGreaterThan(0);

		const workflowText = workflowWithOutput.student_message?.trim();
		if (workflowText) {
			const workflowMessage = workflowPicker.getByText(workflowText, { exact: true });
			await expect(
				workflowMessage,
				`Expected workflow "${workflowWithOutput.workflow_name}" to render the exact student message as its own paragraph`
			).toHaveText(workflowText);
		} else if (evidenceAction) {
			const actionRow = actionRows
				.filter({ has: page.getByText(evidenceAction.action, { exact: true }) })
				.first();
			await expect(
				actionRow.locator('td').nth(0),
				`Expected the "${evidenceAction.action}" row to render the exact action name in the first cell`
			).toHaveText(evidenceAction.action);
			await expect(
				actionRow.locator('td').nth(3),
				`Expected action "${evidenceAction.action}" to render the exact non-empty action output message in the fourth cell`
			).toHaveText(evidenceAction.message!.trim());
		} else {
			throw new Error(
				`Workflow ${workflowWithOutput.workflow_name} on ${completedRun.id} had no visible message evidence to assert.`
			);
		}
	} else {
		const workflowText = workflowWithOutput.student_message?.trim();
		if (!workflowText) {
			throw new Error(
				`Workflow ${workflowWithOutput.workflow_name} on ${completedRun.id} returned no action_results ` +
					`(expected for student role) and no student_message to assert on the detail page.`
			);
		}
		const workflowMessage = page.getByText(workflowText, { exact: true }).first();
		await expect(
			workflowMessage,
			`Expected workflow "${workflowWithOutput.workflow_name}" to render the exact student message on the run detail page`
		).toBeVisible({ timeout: 10_000 });
	}
});
