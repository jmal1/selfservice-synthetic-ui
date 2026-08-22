import { test, expect } from '@playwright/test';
import {
	buildExposition,
	buildPushgatewayUrl,
	countExpectedChecks,
	PUSHGATEWAY_REPLACEMENT_METHOD,
	type CheckResult
} from '../tests/lib/pushgateway.ts';

const safeCheck: CheckResult = {
	check: 'safe_navigation',
	success: 1,
	durationSeconds: 1
};
const lifecycleCheck: CheckResult = {
	check: 'create_and_destroy_synthetic_pod',
	success: 1,
	durationSeconds: 2
};

test('enabled lifecycle exposition includes all checks and complete coverage', () => {
	const body = buildExposition([safeCheck, lifecycleCheck], 2, 123);
	expect(body).toContain('check="create_and_destroy_synthetic_pod"');
	expect(body).toContain('crucible_synthetic_ui_overall_check_count{layer="ui"} 2');
	expect(body).toContain('crucible_synthetic_ui_overall_expected_check_count{layer="ui"} 2');
	expect(body).toContain('crucible_synthetic_ui_overall_coverage_ratio{layer="ui"} 1.000000');
	expect(body).toContain('crucible_synthetic_ui_overall_success{layer="ui"} 1');
});

test('disabled lifecycle replacement drops stale destructive series', () => {
	const enabledBody = buildExposition([safeCheck, lifecycleCheck], 2, 123);
	const disabledBody = buildExposition([safeCheck], 1, 124);

	expect(enabledBody).toContain('check="create_and_destroy_synthetic_pod"');
	expect(disabledBody).not.toContain('create_and_destroy_synthetic_pod');
	expect(disabledBody).toContain('crucible_synthetic_ui_overall_check_count{layer="ui"} 1');
	expect(disabledBody).toContain('crucible_synthetic_ui_overall_expected_check_count{layer="ui"} 1');
	expect(buildPushgatewayUrl('http://pushgateway:9091/', 'ui job')).toBe(
		'http://pushgateway:9091/metrics/job/ui%20job/layer/ui'
	);
	expect(PUSHGATEWAY_REPLACEMENT_METHOD).toBe('PUT');
});

test('missing expected result makes aggregate coverage and success fail', () => {
	const body = buildExposition([safeCheck], 2, 125);
	expect(body).toContain('crucible_synthetic_ui_overall_coverage_ratio{layer="ui"} 0.500000');
	expect(body).toContain('crucible_synthetic_ui_overall_success{layer="ui"} 0');
});

test('forced aggregate failure overrides a complete green-looking result map', () => {
	const body = buildExposition([safeCheck, lifecycleCheck], 2, 126, true);
	expect(body).toContain('crucible_synthetic_ui_overall_check_count{layer="ui"} 2');
	expect(body).toContain('crucible_synthetic_ui_overall_coverage_ratio{layer="ui"} 1.000000');
	expect(body).toContain('crucible_synthetic_ui_overall_success{layer="ui"} 0');
	expect(body).toContain('crucible_synthetic_ui_check_success{check="safe_navigation",layer="ui"} 1');
});

test('expected count excludes configured skips but includes runnable failures', () => {
	expect(
		countExpectedChecks([
			{ expectedStatus: 'passed' },
			{ expectedStatus: 'failed' },
			{ expectedStatus: 'skipped' }
		])
	).toBe(2);
});
