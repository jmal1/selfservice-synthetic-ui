// synthetic.ts — helper to attach actionable metadata to each synthetic
// test. The pushgateway-reporter reads these annotations and emits them
// as labels on the `crucible_synthetic_ui_check_info` gauge, which the
// Grafana dashboard joins against to show human-readable titles,
// descriptions, severities, and runbook URLs alongside pass/fail and
// latency data.
//
// Every synthetic spec MUST call `meta(testInfo, {...})` as its first
// statement. The reporter will warn if a result has no associated
// metadata.

import type { TestInfo } from '@playwright/test';

export interface SyntheticMeta {
	/** Short, human-readable title shown on dashboards. */
	title: string;
	/**
	 * One- or two-sentence description of what this test actually does.
	 * Surfaced on the dashboard tooltip and in Discord alerts so that
	 * a human seeing a failure knows what to investigate without reading
	 * the spec source.
	 */
	description: string;
	/**
	 * Severity drives alert routing/labels. critical = page now;
	 * warning = look at it within an hour; info = monitor only.
	 */
	severity?: 'critical' | 'warning' | 'info';
	/** URL to the runbook section for this check. */
	runbook?: string;
}

export const DEFAULT_RUNBOOK =
	'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#runbook';

export function meta(t: TestInfo, m: SyntheticMeta): void {
	t.annotations.push({ type: 'synthetic-title', description: m.title });
	t.annotations.push({ type: 'synthetic-description', description: m.description });
	t.annotations.push({
		type: 'synthetic-severity',
		description: m.severity ?? 'warning'
	});
	t.annotations.push({
		type: 'synthetic-runbook',
		description: m.runbook ?? DEFAULT_RUNBOOK
	});
}
