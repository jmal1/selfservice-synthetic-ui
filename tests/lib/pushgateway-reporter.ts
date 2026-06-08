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
		// Skipped tests don't represent a pass or a fail — don't push
		// success=0 for them or they'd show as red on the dashboard.
		if (result.status === 'skipped') {
			return;
		}
		const ann = test.annotations ?? [];
		const grab = (type: string): string | undefined =>
			ann.find((a) => a.type === type)?.description ?? undefined;
		this.results.push({
			check: test.title,
			success: result.status === 'passed' ? 1 : 0,
			durationSeconds: result.duration / 1000,
			title: grab('synthetic-title'),
			description: grab('synthetic-description'),
			severity: grab('synthetic-severity'),
			runbook: grab('synthetic-runbook')
		});
	}

	async onEnd(_result: FullResult): Promise<void> {
		await pushResults(this.results);
	}
}

export default PushgatewayReporter;
