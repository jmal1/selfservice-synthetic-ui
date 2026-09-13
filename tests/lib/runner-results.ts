// Pure helpers for runner_results_render discovery and hollowness.
// Kept free of Playwright so unit tests can sabotage-prove the predicates.

export interface ActionResultSummary {
	action: string;
	status: string;
	message?: string | null;
	exit_code: number;
	duration_ms: number;
}

export interface WorkflowResultSummary {
	id: string;
	workflow_name: string;
	status: string;
	student_message?: string | null;
	action_results?: ActionResultSummary[] | null;
}

export interface RunRenderEvidence {
	workflow: WorkflowResultSummary;
	/** Non-empty student-facing text when the API retained it. */
	studentText: string;
	/** Action row with a non-empty message, when the API still returns action_results. */
	evidenceAction?: ActionResultSummary;
	/**
	 * True when the only retained content is a workflow name/status row.
	 * Passing assessments leave student_message null by design (UpdateWorkflowResultBySlug),
	 * so requiring student_message alone is an impossible guard against healthy prod data.
	 */
	nameOnly: boolean;
}

const ACTIVE_STATUSES = new Set(['pending', 'provisioning', 'running']);

export function isTerminalRunStatus(status: string | null | undefined): boolean {
	return !ACTIVE_STATUSES.has((status ?? '').toLowerCase());
}

/**
 * Picks the best workflow result that proves the student testing UI has something
 * to render. Preference order:
 *   1. non-empty student_message (and optional action message when present)
 *   2. action_results row with a non-empty message (instructor/admin payloads)
 *   3. non-empty workflow_name alone (normal student pass — action_results stripped,
 *      student_message null)
 */
export function findRenderEvidence(
	results: WorkflowResultSummary[] | null | undefined
): RunRenderEvidence | undefined {
	const list = results ?? [];
	let nameOnlyFallback: RunRenderEvidence | undefined;

	for (const result of list) {
		const workflowName = (result.workflow_name ?? '').trim();
		if (!workflowName) continue;

		const actionResults = result.action_results ?? [];
		const studentText = (result.student_message ?? '').trim();
		const evidenceAction = actionResults.find(
			(action) => (action.message ?? '').trim().length > 0
		);

		if (studentText) {
			return {
				workflow: result,
				studentText,
				evidenceAction,
				nameOnly: false
			};
		}
		if (evidenceAction) {
			return {
				workflow: result,
				studentText: evidenceAction.message!.trim(),
				evidenceAction,
				nameOnly: false
			};
		}
		if (!nameOnlyFallback) {
			nameOnlyFallback = {
				workflow: result,
				studentText: '',
				nameOnly: true
			};
		}
	}

	return nameOnlyFallback;
}
