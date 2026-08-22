// Custom Playwright reporter that collects per-test pass/fail/duration
// and pushes them to Pushgateway in onEnd().
//
// Test names must be unique within a run; we use the test title (which
// is the spec's `test('<title>', ...)` argument) as the `check` label.

import type {
	Reporter,
	TestCase,
	TestResult,
	FullResult,
	FullConfig,
	Suite
} from '@playwright/test/reporter';
import {
	countExpectedChecks,
	pushResults,
	type CheckResult
} from './pushgateway.ts';
import {
	expectedFullSuiteCheckCount,
	syntheticConfig
} from './config.ts';

class PushgatewayReporter implements Reporter {
	private results = new Map<string, CheckResult>();
	private expectedCheckCount = 0;
	private executionStarted = false;
	private fullSuiteSelected = false;

	onBegin(_config: FullConfig, suite: Suite): void {
		this.expectedCheckCount = countExpectedChecks(suite.allTests());
		this.fullSuiteSelected =
			this.expectedCheckCount ===
			expectedFullSuiteCheckCount(process.env, syntheticConfig);
	}

	onTestBegin(): void {
		this.executionStarted = true;
	}

	onTestEnd(test: TestCase, result: TestResult): void {
		this.executionStarted = true;
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
		this.results.set(test.title, {
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
		if (!this.executionStarted) {
			console.log('[pushgateway] no test execution events; skipping discovery-only push');
			return;
		}
		if (!this.fullSuiteSelected) {
			console.log(
				'[pushgateway] partial/filtered suite detected; refusing to replace the full metric group'
			);
			return;
		}
		await pushResults([...this.results.values()], this.expectedCheckCount);
	}
}

export default PushgatewayReporter;
