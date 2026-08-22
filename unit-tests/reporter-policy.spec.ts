import { test, expect } from '@playwright/test';
import {
	hasIntentionalTestSelection,
	isListOnlyRun,
	shouldPublishReplacement
} from '../tests/lib/reporter-policy.ts';
import { buildExposition } from '../tests/lib/pushgateway.ts';

test('detects explicit CLI test selection without treating normal options as filters', () => {
	expect(
		hasIntentionalTestSelection([
			'node',
			'playwright',
			'test',
			'tests/specs/healthz.spec.ts'
		])
	).toBe(true);
	expect(hasIntentionalTestSelection(['node', 'playwright', 'test', '--grep', 'healthz'])).toBe(
		true
	);
	expect(hasIntentionalTestSelection(['node', 'playwright', 'test', 'healthz'])).toBe(true);
	expect(hasIntentionalTestSelection(['node', 'playwright', 'test', '--workers=1'])).toBe(false);
	expect(hasIntentionalTestSelection(['node', 'playwright', 'test', '--workers', '1'])).toBe(
		false
	);
	expect(hasIntentionalTestSelection(['node', 'playwright', 'test', '--shard=1/2'])).toBe(true);
	expect(
		hasIntentionalTestSelection(['node', 'playwright', 'test', '--project=chromium'])
	).toBe(true);
	expect(
		hasIntentionalTestSelection(['node', 'playwright', 'test', '--grep-invert=slow'])
	).toBe(true);
	expect(
		hasIntentionalTestSelection(['node', 'playwright', 'test', '--test-list', 'checks.txt'])
	).toBe(true);
	expect(
		hasIntentionalTestSelection(['node', 'playwright', 'test', '--test-list=checks.txt'])
	).toBe(true);
	expect(
		hasIntentionalTestSelection([
			'node',
			'playwright',
			'test',
			'--test-list-invert',
			'excluded.txt'
		])
	).toBe(true);
	expect(
		hasIntentionalTestSelection([
			'node',
			'playwright',
			'test',
			'--test-list-invert=excluded.txt'
		])
	).toBe(true);
	expect(hasIntentionalTestSelection(['node', 'playwright', 'test', '--ui'])).toBe(true);
	expect(isListOnlyRun(['node', 'playwright', 'test', '--list'])).toBe(true);
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
		19,
		123
	);
	expect(replacement).toContain(
		'crucible_synthetic_ui_overall_coverage_ratio{layer="ui"} 0.052632'
	);
	expect(replacement).toContain('crucible_synthetic_ui_overall_success{layer="ui"} 0');
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
