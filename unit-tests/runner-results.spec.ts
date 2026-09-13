import { expect, test } from '@playwright/test';
import {
	findRenderEvidence,
	isTerminalRunStatus,
	type WorkflowResultSummary
} from '../tests/lib/runner-results.ts';

function workflow(partial: Partial<WorkflowResultSummary> & { workflow_name: string }): WorkflowResultSummary {
	return {
		id: partial.id ?? 'wr-1',
		workflow_name: partial.workflow_name,
		status: partial.status ?? 'pass',
		student_message: partial.student_message,
		action_results: partial.action_results
	};
}

test('isTerminalRunStatus rejects in-flight statuses only', () => {
	expect(isTerminalRunStatus('completed')).toBe(true);
	expect(isTerminalRunStatus('failed')).toBe(true);
	expect(isTerminalRunStatus('cancelled')).toBe(true);
	expect(isTerminalRunStatus('timeout')).toBe(true);
	expect(isTerminalRunStatus('pending')).toBe(false);
	expect(isTerminalRunStatus('provisioning')).toBe(false);
	expect(isTerminalRunStatus('running')).toBe(false);
	expect(isTerminalRunStatus('RUNNING')).toBe(false);
});

test('findRenderEvidence prefers student_message over name-only', () => {
	const evidence = findRenderEvidence([
		workflow({ workflow_name: 'SSH baseline', student_message: null }),
		workflow({
			id: 'wr-2',
			workflow_name: 'Firewall',
			student_message: 'Port 23 is still open'
		})
	]);
	expect(evidence?.nameOnly).toBe(false);
	expect(evidence?.studentText).toBe('Port 23 is still open');
	expect(evidence?.workflow.workflow_name).toBe('Firewall');
});

test('findRenderEvidence accepts name-only when student_message is null (live student pass)', () => {
	// UpdateWorkflowResultBySlug stores nil when the runner message is empty.
	// Student GET strips action_results. A green pass therefore looks like this.
	const evidence = findRenderEvidence([
		workflow({
			workflow_name: 'Runner smoke: host responds',
			student_message: null,
			action_results: null
		})
	]);
	expect(evidence, 'name-only evidence must be accepted for healthy pass results').toBeTruthy();
	expect(evidence!.nameOnly).toBe(true);
	expect(evidence!.studentText).toBe('');
	expect(evidence!.workflow.workflow_name).toBe('Runner smoke: host responds');
});

test('findRenderEvidence uses action message when action_results are returned', () => {
	const evidence = findRenderEvidence([
		workflow({
			workflow_name: 'SSH baseline',
			student_message: '',
			action_results: [
				{
					action: 'port-22-open',
					status: 'fail',
					message: 'SSH refused',
					exit_code: 1,
					duration_ms: 12
				}
			]
		})
	]);
	expect(evidence?.nameOnly).toBe(false);
	expect(evidence?.studentText).toBe('SSH refused');
	expect(evidence?.evidenceAction?.action).toBe('port-22-open');
});

test('findRenderEvidence sabotage: empty workflow_name is not evidence', () => {
	const evidence = findRenderEvidence([
		workflow({ workflow_name: '   ', student_message: 'should not count' }),
		workflow({ workflow_name: '', action_results: [] })
	]);
	expect(evidence, 'blank workflow names must not satisfy hollowness').toBeUndefined();
});

test('findRenderEvidence sabotage: empty results are not evidence', () => {
	expect(findRenderEvidence([])).toBeUndefined();
	expect(findRenderEvidence(null)).toBeUndefined();
	expect(findRenderEvidence(undefined)).toBeUndefined();
});
