// Pushgateway client for synthetic Playwright runs.
//
// Pushes Prometheus exposition-format metrics to the lab Pushgateway.
// Pushgateway is keyed by job + label set, so we use:
//   job=crucible_synthetic_ui (configurable via PUSHGATEWAY_JOB)
//   layer=ui (fixed; pairs with layer=api from the Go suite)
//   check=<spec name>
//
// Set PUSHGATEWAY_URL=skip to no-op (useful for local dev).

const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL ?? 'http://pushgateway.lab.jmal.io:9091';
const JOB = process.env.PUSHGATEWAY_JOB ?? 'crucible_synthetic_ui';
export const PUSHGATEWAY_REPLACEMENT_METHOD = 'PUT';

export interface CheckResult {
	check: string;
	success: 0 | 1;
	durationSeconds: number;
	// Metadata for the *_info series — populated from test annotations.
	title?: string;
	description?: string;
	severity?: string;
	runbook?: string;
}

export function countExpectedChecks(
	tests: ReadonlyArray<{ expectedStatus: string }>
): number {
	return tests.filter((test) => test.expectedStatus !== 'skipped').length;
}

function escapeLabel(v: string): string {
	return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function buildExposition(
	results: CheckResult[],
	expectedCheckCount = results.length,
	now = Math.floor(Date.now() / 1000),
	forceOverallFailure = false
): string {
	const lines: string[] = [
		'# HELP crucible_synthetic_ui_check_success 1 if the check passed, 0 otherwise',
		'# TYPE crucible_synthetic_ui_check_success gauge',
		'# HELP crucible_synthetic_ui_check_duration_seconds Wall-clock duration of the check',
		'# TYPE crucible_synthetic_ui_check_duration_seconds gauge',
		'# HELP crucible_synthetic_ui_check_last_run_timestamp Unix epoch of the most recent run',
		'# TYPE crucible_synthetic_ui_check_last_run_timestamp gauge',
		'# HELP crucible_synthetic_ui_check_info Per-check metadata (title, description, severity, runbook). Always 1; join other series on check.',
		'# TYPE crucible_synthetic_ui_check_info gauge'
	];
	for (const r of results) {
		const lbl = `{check="${escapeLabel(r.check)}",layer="ui"}`;
		lines.push(`crucible_synthetic_ui_check_success${lbl} ${r.success}`);
		lines.push(`crucible_synthetic_ui_check_duration_seconds${lbl} ${r.durationSeconds.toFixed(3)}`);
		lines.push(`crucible_synthetic_ui_check_last_run_timestamp${lbl} ${now}`);
		// Always emit info — even if metadata is missing — so the dashboard
		// joins always succeed and a missing title is visibly empty rather
		// than collapsing the row entirely.
		const infoLbl = [
			`check="${escapeLabel(r.check)}"`,
			`layer="ui"`,
			`title="${escapeLabel(r.title ?? r.check)}"`,
			`description="${escapeLabel(r.description ?? '')}"`,
			`severity="${escapeLabel(r.severity ?? 'warning')}"`,
			`runbook="${escapeLabel(r.runbook ?? '')}"`
		].join(',');
		lines.push(`crucible_synthetic_ui_check_info{${infoLbl}} 1`);
	}
	const coverage = expectedCheckCount === 0 ? 1 : results.length / expectedCheckCount;
	const anyFail =
		forceOverallFailure ||
		results.some((r) => r.success === 0) ||
		results.length !== expectedCheckCount
			? 0
			: 1;
	lines.push(
		`crucible_synthetic_ui_overall_success{layer="ui"} ${anyFail}`,
		`crucible_synthetic_ui_overall_last_run_timestamp{layer="ui"} ${now}`,
		`crucible_synthetic_ui_overall_check_count{layer="ui"} ${results.length}`,
		`crucible_synthetic_ui_overall_expected_check_count{layer="ui"} ${expectedCheckCount}`,
		`crucible_synthetic_ui_overall_coverage_ratio{layer="ui"} ${coverage.toFixed(6)}`
	);
	return lines.join('\n') + '\n';
}

export function buildPushgatewayUrl(baseUrl: string, job: string): string {
	return `${baseUrl.replace(/\/$/, '')}/metrics/job/${encodeURIComponent(job)}/layer/ui`;
}

export async function pushResults(
	results: CheckResult[],
	expectedCheckCount = results.length,
	forceOverallFailure = false
): Promise<void> {
	if (PUSHGATEWAY_URL === 'skip') {
		console.log('[pushgateway] PUSHGATEWAY_URL=skip — not pushing', results.length, 'results');
		return;
	}
	const body = buildExposition(
		results,
		expectedCheckCount,
		Math.floor(Date.now() / 1000),
		forceOverallFailure
	);
	const url = buildPushgatewayUrl(PUSHGATEWAY_URL, JOB);
	try {
		const res = await fetch(url, {
			method: PUSHGATEWAY_REPLACEMENT_METHOD,
			headers: { 'Content-Type': 'text/plain; version=0.0.4' },
			body,
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) {
			const text = await res.text();
			console.error(`[pushgateway] push failed: ${res.status} ${text}`);
			return;
		}
		console.log(`[pushgateway] pushed ${results.length} results to ${url}`);
	} catch (err) {
		console.error('[pushgateway] push error:', err);
	}
}
