import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPORT_KEEP_RUNS_DEFAULT = 3;
export const EXACT_IMAGE_REFERENCE = /^ghcr\.io\/jmal1\/selfservice-synthetic-ui:[0-9a-f]{40}$/;
const CONTAINER_REPORT_ROOT = '/app/playwright-report';
const CONTAINER_RESULTS_ROOT = '/app/test-results';

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

function assertRealDirectory(directory, label) {
	let stat;
	try {
		stat = lstatSync(directory);
	} catch (error) {
		if (error?.code === 'ENOENT') {
			throw new Error(`${label} does not exist: ${directory}`);
		}
		throw error;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`${label} must be a real directory, not a symlink or file: ${directory}`);
	}
}

function probeDirectoryWrite(directory, label) {
	let probe;
	try {
		probe = mkdtempSync(path.join(directory, '.synthetic-ui-write-probe-'));
	} catch (error) {
		throw new Error(`${label} is not writable by container UID ${process.getuid?.() ?? 'unknown'}: ${error.message}`);
	}
	rmdirSync(probe);
}

export function assertReportStorageWritable(
	reportRoot = CONTAINER_REPORT_ROOT,
	resultsRoot = CONTAINER_RESULTS_ROOT
) {
	const resolvedReportRoot = path.resolve(reportRoot);
	const resolvedResultsRoot = path.resolve(resultsRoot);
	const runsRoot = reportRunsRoot(resolvedReportRoot);

	assertRealDirectory(resolvedReportRoot, 'report root');
	assertRealDirectory(resolvedResultsRoot, 'results root');

	try {
		mkdirSync(runsRoot);
	} catch (error) {
		if (error?.code !== 'EEXIST') throw error;
	}
	assertRealDirectory(runsRoot, 'report runs root');

	probeDirectoryWrite(resolvedReportRoot, 'report root');
	probeDirectoryWrite(runsRoot, 'report runs root');
	probeDirectoryWrite(resolvedResultsRoot, 'results root');

	return { reportRoot: resolvedReportRoot, runsRoot, resultsRoot: resolvedResultsRoot };
}

export function pruneReportRuns(reportRoot, keepRuns = REPORT_KEEP_RUNS_DEFAULT) {
	if (!Number.isInteger(keepRuns) || keepRuns < 1) {
		throw new Error(`report retention count must be a positive integer; received ${JSON.stringify(keepRuns)}`);
	}

	const runsRoot = reportRunsRoot(reportRoot);
	assertRealDirectory(runsRoot, 'report runs root');

	const entries = readdirSync(runsRoot, { withFileTypes: true });
	const runs = entries.map((entry) => {
		const entryPath = path.resolve(runsRoot, entry.name);
		if (path.dirname(entryPath) !== runsRoot) {
			throw new Error(`report run path escaped ${runsRoot}: ${entry.name}`);
		}
		const stat = lstatSync(entryPath);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`unexpected non-directory entry under ${runsRoot}: ${entry.name}`);
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
		const stat = lstatSync(entry.path);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`report run changed before pruning: ${entry.name}`);
		}
		rmSync(entry.path, { recursive: true, force: false });
	}

	return {
		root: path.resolve(reportRoot),
		runsRoot,
		retained: retained.map((entry) => entry.name),
		pruned: pruned.map((entry) => entry.name)
	};
}

function runContainerCommand(args) {
	const uid = process.getuid?.();
	if (uid !== 1001) {
		throw new Error(`container report commands must run as pwuser UID 1001; received ${uid ?? 'unknown'}`);
	}
	const [command, value, ...extra] = args;
	if (extra.length > 0) {
		throw new Error(`unexpected report-storage arguments: ${extra.join(' ')}`);
	}
	if (command === 'preflight' && value === undefined) {
		assertReportStorageWritable();
		return;
	}
	if (command === 'prune' && /^[1-9][0-9]*$/.test(value ?? '')) {
		pruneReportRuns(CONTAINER_REPORT_ROOT, Number(value));
		return;
	}
	throw new Error('usage: deployment-guardrails.mjs preflight | prune <positive keep count>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		runContainerCommand(process.argv.slice(2));
	} catch (error) {
		console.error(`[synthetic-ui] report storage command failed: ${error.message}`);
		process.exitCode = 1;
	}
}
