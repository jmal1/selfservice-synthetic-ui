import { test, expect } from '@playwright/test';
import {
	hasIntentionalTestSelection,
	isListOnlyRun,
	mustForceOverallFailure,
	shouldPublishReplacement
} from '../tests/lib/reporter-policy.ts';
import { buildExposition } from '../tests/lib/pushgateway.ts';

const cli = (...args: string[]) => ['node', 'playwright', 'test', ...args];

test('every Playwright selection, repeat, reconfiguration, and interactive option is non-publishing', () => {
	const cases: string[][] = [
		['tests/specs/healthz.spec.ts'],
		['healthz'],
		['--browser', 'chromium'],
		['--browser=chromium'],
		['-c', 'other.config.ts'],
		['-cother.config.ts'],
		['-c=other.config.ts'],
		['--config', 'other.config.ts'],
		['--config=other.config.ts'],
		['--debug'],
		['--debug', 'cli'],
		['--debug=console'],
		['-g', 'healthz'],
		['-ghealthz'],
		['-g=healthz'],
		['--grep', 'healthz'],
		['--grep=healthz'],
		['--grep-invert', 'slow'],
		['--grep-invert=slow'],
		['--last-failed'],
		['--only-changed'],
		['--only-changed', 'origin/master'],
		['--only-changed=origin/master'],
		['--project', 'chromium'],
		['--project=chromium'],
		['--repeat-each', '2'],
		['--repeat-each=2'],
		['--run-agents', 'missing'],
		['--run-agents=missing'],
		['--shard', '1/2'],
		['--shard=1/2'],
		['--test-list', 'checks.txt'],
		['--test-list=checks.txt'],
		['--test-list-invert', 'excluded.txt'],
		['--test-list-invert=excluded.txt'],
		['--ui'],
		['--ui-host', '127.0.0.1'],
		['--ui-host=127.0.0.1'],
		['--ui-port', '9323'],
		['--ui-port=9323'],
		['-u'],
		['-uall'],
		['-u=all'],
		['--update-snapshots'],
		['--update-snapshots=all'],
		['--update-source-method', 'patch'],
		['--update-source-method=patch'],
		['-x', 'tests/specs/healthz.spec.ts']
	];

	for (const args of cases) {
		expect(hasIntentionalTestSelection(cli(...args)), args.join(' ')).toBe(true);
	}
});

test('every value-taking full-run option consumes split, equal, and attached values', () => {
	const cases: string[][] = [
		['--global-timeout', '60000'],
		['--global-timeout=60000'],
		['--max-failures', '1'],
		['--max-failures=1'],
		['--output', 'test-results'],
		['--output=test-results'],
		['--reporter', 'list'],
		['--reporter=list'],
		['--retries', '1'],
		['--retries=1'],
		['--timeout', '30000'],
		['--timeout=30000'],
		['--trace', 'on'],
		['--trace=on'],
		['--tsconfig', 'tsconfig.json'],
		['--tsconfig=tsconfig.json'],
		['-j', '1'],
		['-j1'],
		['-j=1'],
		['--workers', '1'],
		['--workers=1']
	];

	for (const args of cases) {
		expect(hasIntentionalTestSelection(cli(...args)), args.join(' ')).toBe(false);
	}
});

test('boolean full-run options do not hide later positional selectors', () => {
	const booleanOptions = [
		'--fail-on-flaky-tests',
		'--forbid-only',
		'--fully-parallel',
		'--headed',
		'--ignore-snapshots',
		'--no-deps',
		'--pass-with-no-tests',
		'--quiet',
		'-x'
	];
	for (const option of booleanOptions) {
		expect(hasIntentionalTestSelection(cli(option)), option).toBe(false);
		expect(
			hasIntentionalTestSelection(cli(option, 'tests/specs/healthz.spec.ts')),
			`${option} with positional filter`
		).toBe(true);
	}
});

test('environment debug modes and list-only discovery are non-publishing', () => {
	expect(hasIntentionalTestSelection(cli(), { PWDEBUG: '1' })).toBe(true);
	expect(hasIntentionalTestSelection(cli(), { PWDEBUG: 'console' })).toBe(true);
	expect(hasIntentionalTestSelection(cli(), { PWDEBUG: '' })).toBe(false);
	expect(isListOnlyRun(cli('--list'))).toBe(true);
});

test('intentional filtered execution does not replace the production group', () => {
	expect(
		shouldPublishReplacement({
			intentionallyFiltered: true,
			listOnly: false
		})
	).toBe(false);
});

test('incomplete full execution replaces stale green metrics with failed coverage', () => {
	expect(
		shouldPublishReplacement({
			intentionallyFiltered: false,
			listOnly: false
		})
	).toBe(true);

	const replacement = buildExposition(
		[{ check: 'safe_navigation', success: 1, durationSeconds: 1 }],
		20,
		123
	);
	expect(replacement).toContain(
		'crucible_synthetic_ui_overall_coverage_ratio{layer="ui"} 0.050000'
	);
	expect(replacement).toContain('crucible_synthetic_ui_overall_success{layer="ui"} 0');
});

test('non-passed full result forces failure even with complete discovery', () => {
	expect(mustForceOverallFailure('failed', 20, 20)).toBe(true);
	expect(mustForceOverallFailure('timedout', 20, 20)).toBe(true);
	expect(mustForceOverallFailure('passed', 20, 20)).toBe(false);
});

test('discovery mismatch forces failure even when Playwright reports passed', () => {
	expect(mustForceOverallFailure('passed', 19, 20)).toBe(true);
	expect(mustForceOverallFailure('passed', 21, 20)).toBe(true);
});

test('list-only discovery is the only unfiltered zero-execution mode that does not replace metrics', () => {
	expect(
		shouldPublishReplacement({
			intentionallyFiltered: false,
			listOnly: true
		})
	).toBe(false);
	expect(
		shouldPublishReplacement({
			intentionallyFiltered: false,
			listOnly: false
		})
	).toBe(true);
});
