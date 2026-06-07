// Custom Playwright reporter that collects per-test pass/fail/duration
// and pushes them to Pushgateway in onEnd().
//
// Test names must be unique within a run; we use the test title (which
// is the spec's `test('<title>', ...)` argument) as the `check` label.

import type {
	Reporter,
	TestCase,
	TestResult,
	FullResult
} from '@playwright/test/reporter';
import { pushResults, type CheckResult } from './pushgateway.ts';

class PushgatewayReporter implements Reporter {
	private results: CheckResult[] = [];

	onTestEnd(test: TestCase, result: TestResult): void {
		// Only record the final attempt (skip retries' intermediate fails)
		if (result.retry < (test.retries ?? 0) && result.status === 'failed') {
			return;
		}
		this.results.push({
			check: test.title,
			success: result.status === 'passed' ? 1 : 0,
			durationSeconds: result.duration / 1000
		});
	}

	async onEnd(_result: FullResult): Promise<void> {
		await pushResults(this.results);
	}
}

export default PushgatewayReporter;
