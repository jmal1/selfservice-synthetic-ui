import { mkdirSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';

export const REPORT_KEEP_RUNS_DEFAULT = 3;
export const EXACT_IMAGE_REFERENCE = /^ghcr\.io\/jmal1\/selfservice-synthetic-ui:[0-9a-f]{40}$/;

export function assertExactImageReference(value, name = 'SYNTHETIC_UI_IMAGE') {
	const normalized = value?.trim();
	if (!normalized) {
		throw new Error(
			`${name} must be set to ghcr.io/jmal1/selfservice-synthetic-ui:<40-character lowercase commit SHA>`
		);
	}
	if (!EXACT_IMAGE_REFERENCE.test(normalized)) {
		throw new Error(
			`${name} must be an immutable ghcr.io/jmal1/selfservice-synthetic-ui:<40-character lowercase commit SHA> tag; received ${JSON.stringify(normalized)}`
		);
	}
	return normalized;
}

export function reportRunId(env = process.env) {
	const normalized = env.PLAYWRIGHT_REPORT_RUN_ID?.trim();
	return normalized && normalized.length > 0 ? normalized : 'latest';
}

export function createReportRunId(now = new Date(), pid = process.pid) {
	const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	return `${stamp}-${pid}`;
}

export function playwrightReportOutputFolder(env = process.env) {
	return `./playwright-report/runs/${reportRunId(env)}`;
}

export function reportRunsRoot(reportRoot) {
	return path.resolve(reportRoot, 'runs');
}

function assertSafeRunId(runId) {
	if (typeof runId !== 'string' || runId.trim() === '') {
		throw new Error('report run id must be a non-empty string');
	}
	if (runId !== runId.trim()) {
		throw new Error(`report run id must not include leading or trailing whitespace: ${JSON.stringify(runId)}`);
	}
	if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
		throw new Error(`report run id must stay within the report root: ${JSON.stringify(runId)}`);
	}
	return runId;
}

export function reportRunPath(reportRoot, runId) {
	return path.join(reportRunsRoot(reportRoot), assertSafeRunId(runId));
}

export function pruneReportRuns(reportRoot, keepRuns = REPORT_KEEP_RUNS_DEFAULT) {
	if (!Number.isInteger(keepRuns) || keepRuns < 1) {
		throw new Error(`report retention count must be a positive integer; received ${JSON.stringify(keepRuns)}`);
	}

	const runsRoot = reportRunsRoot(reportRoot);
	mkdirSync(runsRoot, { recursive: true });

	const entries = readdirSync(runsRoot, { withFileTypes: true });
	const runs = entries.map((entry) => {
		const entryPath = path.join(runsRoot, entry.name);
		const stat = lstatSync(entryPath);
		if (!stat.isDirectory()) {
			throw new Error(`unexpected non-directory entry in ${runsRoot}: ${entry.name}`);
		}
		return {
			name: entry.name,
			path: entryPath,
			mtimeMs: stat.mtimeMs
		};
	});

	runs.sort((left, right) => {
		if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
		return left.name.localeCompare(right.name);
	});

	const retained = runs.slice(0, keepRuns);
	const pruned = runs.slice(keepRuns);
	for (const entry of pruned) {
		rmSync(entry.path, { recursive: true, force: true });
	}

	return {
		root: path.resolve(reportRoot),
		runsRoot,
		retained: retained.map((entry) => entry.name),
		pruned: pruned.map((entry) => entry.name)
	};
}
