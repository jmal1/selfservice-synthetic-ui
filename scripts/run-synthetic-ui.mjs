import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertExactImageReference,
	createReportRunId,
	playwrightReportOutputFolder,
	pruneReportRuns,
	reportRunsRoot
} from './deployment-guardrails.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const composeFile = path.join(repoRoot, 'deploy', 'docker-compose.yml');
const reportRoot = process.env.SYNTHETIC_REPORT_ROOT ?? '/opt/synthetic-ui/report';
const keepRunsRaw = process.env.SYNTHETIC_REPORT_KEEP_RUNS ?? '3';
const keepRuns = Number.parseInt(keepRunsRaw, 10);
const runId = createReportRunId();
const image = assertExactImageReference(process.env.SYNTHETIC_UI_IMAGE);
if (reportRoot.trim() === '') {
	throw new Error('SYNTHETIC_REPORT_ROOT must be a non-empty path');
}
if (!Number.isInteger(keepRuns) || keepRuns < 1) {
	throw new Error(
		`SYNTHETIC_REPORT_KEEP_RUNS must be a positive integer; received ${JSON.stringify(keepRunsRaw)}`
	);
}
const env = {
	...process.env,
	SYNTHETIC_UI_IMAGE: image,
	PLAYWRIGHT_REPORT_RUN_ID: runId
};

mkdirSync(reportRunsRoot(reportRoot), { recursive: true });
console.log(`[synthetic-ui] report output folder: ${playwrightReportOutputFolder(env)}`);

const result = spawnSync('docker', ['compose', '-f', composeFile, 'run', '--rm', 'monitor'], {
	cwd: repoRoot,
	env,
	stdio: 'inherit'
});

let exitCode = result.status ?? 1;
if (result.error) {
	console.error(`[synthetic-ui] docker compose launch failed: ${result.error.message}`);
	exitCode = result.status ?? 1;
}
if (result.signal) {
	console.error(`[synthetic-ui] docker compose terminated by signal ${result.signal}`);
	exitCode = 1;
}

try {
	const retention = pruneReportRuns(reportRoot, keepRuns);
	console.log(
		`[synthetic-ui] retained report runs (${retention.retained.length}/${keepRuns}): ${retention.retained.join(', ')}`
	);
	if (retention.pruned.length > 0) {
		console.log(`[synthetic-ui] pruned old report runs: ${retention.pruned.join(', ')}`);
	}
} catch (error) {
	console.error('[synthetic-ui] report retention failed:', error);
	if (exitCode === 0) {
		exitCode = 1;
	}
}

process.exitCode = exitCode;
