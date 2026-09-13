// runner-results.spec.ts — asserts that assessment results render in the
// student-owned pod testing UI for a retained completed run.
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
//      (workflow name always; student_message / action rows when the API has them)
//
// Hollowness guard: FAILs (does NOT skip) when no student-visible terminal run
// retains at least one workflow_name. Requiring non-empty student_message alone
// was too sensitive — UpdateWorkflowResultBySlug stores nil on pass, the student
// API strips action_results, and smoke/pass playlists emit no STUDENT_MSG. That
// made the check depend on a manually seeded fixture message rather than the
// live render contract. Prefer student_message when present; accept name-only
// evidence for healthy passes. Discovery uses the run-history endpoint (up to
// 100) rather than dashboard recent_runs (10) so a seeded fail message cannot
// age out of the window and turn the check red.

import { expect, test } from '../lib/fixtures.ts';
import { parsePodSummaries } from '../lib/maintenance.ts';
import {
	findRenderEvidence,
	isTerminalRunStatus,
	type WorkflowResultSummary
} from '../lib/runner-results.ts';
import { meta } from '../lib/synthetic.ts';

interface RunSummary {
	id: string;
	pod_id?: string;
	status?: string;
	started_at?: string | null;
}

interface PodTestingRunDetail extends RunSummary {
	results?: WorkflowResultSummary[];
}

test('runner_results_render', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Student-owned assessment run results render',
		description:
			'Finds a terminal assessment run attached to the logged-in synthetic student\'s own pods via ' +
			'GET /api/v1/pods + /testing/runs history, verifies the pod testing dashboard + history pages, ' +
			'then navigates to the completed run detail and asserts Workflow Results render (workflow name, ' +
			'and student_message / action output when retained). Catches broken results rendering, a stalled ' +
			'runner that never writes results back, or a broken dashboard navigation path. Deliberately FAILs ' +
			'(does not skip) if no retained student-owned run with workflow results exists in production.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Crucible/blob/main/future/Synthetic-Monitoring.md#when-runner_results_render-fails'
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
		let podsInspected = 0;
		let terminalCandidates = 0;
		let detailLookups = 0;

		// Prefer a run that still carries student-facing text when available,
		// but fall back to name-only evidence so healthy passes are not red.
		let nameOnlyMatch:
			| {
					podId: string;
					run: RunSummary;
					evidence: NonNullable<ReturnType<typeof findRenderEvidence>>;
			  }
			| undefined;

		for (const pod of pods) {
			const podId = pod.id;
			podsInspected += 1;

			const historyResp = await page.request.get(`/api/v1/pods/${podId}/testing/runs`, {
				headers: { accept: 'application/json' },
				failOnStatusCode: false,
				timeout: 15_000
			});
			if (historyResp.status() === 404) continue;
			if (historyResp.status() !== 200) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing/runs returned ${historyResp.status()} for a student-owned pod. ` +
						`This is not a normal destroyed-pod 404 and should be investigated.`
				);
			}
			const history = await historyResp.json();
			if (!Array.isArray(history)) {
				throw new Error(
					`GET /api/v1/pods/${podId}/testing/runs returned a non-array payload for a student-owned pod`
				);
			}

			for (const candidate of (history as RunSummary[]).slice(0, 100)) {
				if (!candidate?.id || !isTerminalRunStatus(candidate.status)) continue;
				terminalCandidates += 1;
				detailLookups += 1;

				const detailResp = await page.request.get(
					`/api/v1/pods/${podId}/testing/runs/${candidate.id}`,
					{
						headers: { accept: 'application/json' },
						failOnStatusCode: false,
						timeout: 15_000
					}
				);
				if (detailResp.status() === 404) continue;
				if (detailResp.status() !== 200) {
					throw new Error(
						`GET /api/v1/pods/${podId}/testing/runs/${candidate.id} returned ${detailResp.status()} for the student-owned pod; ` +
							`this is not a normal destroyed-pod 404 and should be investigated.`
					);
				}
				const detail: PodTestingRunDetail = await detailResp.json();
				if (detail.id !== candidate.id || !isTerminalRunStatus(detail.status)) {
					continue;
				}

				const evidence = findRenderEvidence(detail.results);
				if (!evidence) continue;

				if (!evidence.nameOnly) {
					return { podId, run: candidate, evidence, podsInspected, terminalCandidates, detailLookups };
				}
				if (!nameOnlyMatch) {
					nameOnlyMatch = { podId, run: candidate, evidence };
				}
			}
		}

		if (nameOnlyMatch) {
			return {
				...nameOnlyMatch,
				podsInspected,
				terminalCandidates,
				detailLookups
			};
		}

		throw new Error(
			`No terminal assessment run with student-visible workflow results remained attached to a student-visible pod after inspecting ` +
				`${podsInspected} pods (${terminalCandidates} terminal candidates, ${detailLookups} detail lookups). ` +
				`Each candidate either had pod routes return 404 after completion (destroyed smoke pod), was still active, or ` +
				`had no workflow_name on any result. Keep an active student-owned pod with at least one completed run that retained results ` +
				`(fixture ui-runner-results-fixture is the usual seed).`
		);
	};

	const retainedRun = await findRetainedTerminalRun(studentPods);
	const { podId, run: completedRun, evidence } = retainedRun;
	const workflowWithOutput = evidence.workflow;
	const evidenceAction = evidence.evidenceAction;
	const evidenceText = evidence.studentText;

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

		if (evidenceText && !evidence.nameOnly) {
			const workflowText = (workflowWithOutput.student_message ?? '').trim();
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
			}
		}
	} else if (evidenceText && !evidence.nameOnly) {
		const workflowMessage = page.getByText(evidenceText, { exact: true }).first();
		await expect(
			workflowMessage,
			`Expected workflow "${workflowWithOutput.workflow_name}" to render the exact student message on the run detail page`
		).toBeVisible({ timeout: 10_000 });
	} else {
		// Name-only path: student pass with stripped action_results and null student_message.
		// The workflow picker visibility assertion above is the hollowness proof.
		await expect(
			workflowPicker.getByText(workflowWithOutput.workflow_name, { exact: true }),
			`Expected workflow name "${workflowWithOutput.workflow_name}" to remain visible after expand`
		).toBeVisible();
	}
});
