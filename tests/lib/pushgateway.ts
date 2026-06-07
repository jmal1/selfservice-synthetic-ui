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

export interface CheckResult {
	check: string;
	success: 0 | 1;
	durationSeconds: number;
}

function escapeLabel(v: string): string {
	return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function buildExposition(results: CheckResult[]): string {
	const now = Math.floor(Date.now() / 1000);
	const lines: string[] = [
		'# HELP crucible_synthetic_ui_check_success 1 if the check passed, 0 otherwise',
		'# TYPE crucible_synthetic_ui_check_success gauge',
		'# HELP crucible_synthetic_ui_check_duration_seconds Wall-clock duration of the check',
		'# TYPE crucible_synthetic_ui_check_duration_seconds gauge',
		'# HELP crucible_synthetic_ui_check_last_run_timestamp Unix epoch of the most recent run',
		'# TYPE crucible_synthetic_ui_check_last_run_timestamp gauge'
	];
	for (const r of results) {
		const lbl = `{check="${escapeLabel(r.check)}",layer="ui"}`;
		lines.push(`crucible_synthetic_ui_check_success${lbl} ${r.success}`);
		lines.push(`crucible_synthetic_ui_check_duration_seconds${lbl} ${r.durationSeconds.toFixed(3)}`);
		lines.push(`crucible_synthetic_ui_check_last_run_timestamp${lbl} ${now}`);
	}
	const anyFail = results.some((r) => r.success === 0) ? 0 : 1;
	lines.push(
		`crucible_synthetic_ui_overall_success{layer="ui"} ${anyFail}`,
		`crucible_synthetic_ui_overall_last_run_timestamp{layer="ui"} ${now}`,
		`crucible_synthetic_ui_overall_check_count{layer="ui"} ${results.length}`
	);
	return lines.join('\n') + '\n';
}

export async function pushResults(results: CheckResult[]): Promise<void> {
	if (PUSHGATEWAY_URL === 'skip') {
		console.log('[pushgateway] PUSHGATEWAY_URL=skip — not pushing', results.length, 'results');
		return;
	}
	if (results.length === 0) {
		console.log('[pushgateway] no results to push');
		return;
	}
	const body = buildExposition(results);
	const url = `${PUSHGATEWAY_URL.replace(/\/$/, '')}/metrics/job/${encodeURIComponent(JOB)}/layer/ui`;
	try {
		const res = await fetch(url, {
			method: 'POST',
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
