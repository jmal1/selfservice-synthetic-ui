import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadGuardrails() {
	// @ts-expect-error Runtime module has no TypeScript declaration.
	return import('../scripts/deployment-guardrails.mjs');
}

test('exact image references reject mutable tags and require the published full SHA tag', async () => {
	const { assertExactImageReference, createReportRunId } = await loadGuardrails();
	expect(createReportRunId(new Date('2026-08-25T14:19:21.654Z'), 1234)).toBe('20260825T141921Z-1234');
	expect(
		assertExactImageReference(`ghcr.io/jmal1/selfservice-synthetic-ui:${'a'.repeat(40)}`)
	).toBe(`ghcr.io/jmal1/selfservice-synthetic-ui:${'a'.repeat(40)}`);
	expect(() => assertExactImageReference('ghcr.io/jmal1/selfservice-synthetic-ui:latest')).toThrow(
		'immutable ghcr.io/jmal1/selfservice-synthetic-ui:<40-character lowercase commit SHA> tag'
	);
	expect(() => assertExactImageReference('ghcr.io/jmal1/selfservice-synthetic-ui:b61ca0c5a353')).toThrow(
		'immutable ghcr.io/jmal1/selfservice-synthetic-ui:<40-character lowercase commit SHA> tag'
	);
});

test('playwright HTML output is scoped to the current run id', async () => {
	const { playwrightReportOutputFolder } = await loadGuardrails();
	expect(playwrightReportOutputFolder()).toBe('./playwright-report/runs/latest');
	expect(
		playwrightReportOutputFolder({
			PLAYWRIGHT_REPORT_RUN_ID: '20260825T141921Z-1234'
		})
	).toBe('./playwright-report/runs/20260825T141921Z-1234');
});

test('report retention keeps the newest directories, is idempotent, and stays inside the runs root', async () => {
	const { pruneReportRuns, reportRunPath } = await loadGuardrails();
	const root = mkdtempSync(join(tmpdir(), 'synthetic-ui-report-'));
	const runsRoot = join(root, 'runs');
	mkdirSync(runsRoot, { recursive: true });

	const runDirs = [
		createRunDir(runsRoot, '20260825T140000Z-1001', 30_000),
		createRunDir(runsRoot, '20260825T141000Z-1002', 20_000),
		createRunDir(runsRoot, '20260825T142000Z-1003', 10_000),
		createRunDir(runsRoot, '20260825T143000Z-1004', 0)
	];
	expect(runDirs).toHaveLength(4);
	const outsideFile = join(root, 'leave-me-alone.txt');
	writeFileSync(outsideFile, 'keep');

	const first = pruneReportRuns(root, 2);
	expect(first.retained).toEqual(['20260825T143000Z-1004', '20260825T142000Z-1003']);
	expect(first.pruned).toEqual(['20260825T141000Z-1002', '20260825T140000Z-1001']);
	expect(existsSync(outsideFile)).toBe(true);
	expect(existsSync(join(runsRoot, '20260825T143000Z-1004'))).toBe(true);
	expect(existsSync(join(runsRoot, '20260825T142000Z-1003'))).toBe(true);
	expect(existsSync(join(runsRoot, '20260825T141000Z-1002'))).toBe(false);
	expect(existsSync(join(runsRoot, '20260825T140000Z-1001'))).toBe(false);

	const second = pruneReportRuns(root, 2);
	expect(second.retained).toEqual(first.retained);
	expect(second.pruned).toEqual([]);
	expect(reportRunPath(root, '20260825T143000Z-1004')).toBe(
		join(runsRoot, '20260825T143000Z-1004')
	);
	expect(() => reportRunPath(root, '../escape')).toThrow('report run id must stay within the report root');
});

test('report retention fails visibly when the runs directory contains unexpected files', async () => {
	const { pruneReportRuns } = await loadGuardrails();
	const root = mkdtempSync(join(tmpdir(), 'synthetic-ui-report-invalid-'));
	const runsRoot = join(root, 'runs');
	mkdirSync(runsRoot, { recursive: true });
	writeFileSync(join(runsRoot, 'unexpected.txt'), 'not a run directory');
	expect(() => pruneReportRuns(root, 1)).toThrow('unexpected non-directory entry');
});

test('report retention rejects a symlink without touching its target', async () => {
	const { pruneReportRuns } = await loadGuardrails();
	const root = mkdtempSync(join(tmpdir(), 'synthetic-ui-report-symlink-'));
	const runsRoot = join(root, 'runs');
	const outsideRoot = mkdtempSync(join(tmpdir(), 'synthetic-ui-report-outside-'));
	const sentinel = join(outsideRoot, 'sentinel.txt');
	mkdirSync(runsRoot, { recursive: true });
	writeFileSync(sentinel, 'keep');
	symlinkSync(outsideRoot, join(runsRoot, 'unexpected-link'), 'junction');

	expect(() => pruneReportRuns(root, 1)).toThrow('unexpected non-directory entry');
	expect(existsSync(sentinel)).toBe(true);
	expect(existsSync(join(runsRoot, 'unexpected-link'))).toBe(true);
});

test('report storage preflight creates runs and proves report/results writes', async () => {
	const { assertReportStorageWritable } = await loadGuardrails();
	const reportRoot = mkdtempSync(join(tmpdir(), 'synthetic-ui-report-preflight-'));
	const resultsRoot = mkdtempSync(join(tmpdir(), 'synthetic-ui-results-preflight-'));

	const storage = assertReportStorageWritable(reportRoot, resultsRoot);
	expect(storage.reportRoot).toBe(reportRoot);
	expect(storage.resultsRoot).toBe(resultsRoot);
	expect(storage.runsRoot).toBe(join(reportRoot, 'runs'));
	expect(existsSync(storage.runsRoot)).toBe(true);
});

test('bash host wrapper delegates retention and preserves the compose exit code', () => {
	const root = mkdtempSync(join(tmpdir(), 'synthetic-ui-wrapper-'));
	const reportRoot = join(root, 'report');
	const runsRoot = join(reportRoot, 'runs');
	const dockerDir = join(root, 'bin');
	const logFile = join(root, 'docker.log');
	mkdirSync(runsRoot, { recursive: true });
	mkdirSync(dockerDir, { recursive: true });

	createRunDir(runsRoot, '20260825T140000Z-1001', 30_000);
	createRunDir(runsRoot, '20260825T141000Z-1002', 20_000);
	createRunDir(runsRoot, '20260825T142000Z-1003', 10_000);
	createRunDir(runsRoot, '20260825T143000Z-1004', 0);
	const outsideFile = join(root, 'leave-me-alone.txt');
	writeFileSync(outsideFile, 'keep');

	const fakeDocker = join(dockerDir, 'docker');
	writeFileSync(
		fakeDocker,
		[
			'#!/usr/bin/env bash',
			'set -euo pipefail',
			'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
			'case "$*" in',
			'  *"deployment-guardrails.mjs preflight"*|*"deployment-guardrails.mjs prune "*) exit 0 ;;',
			'  *) exit "${FAKE_DOCKER_EXIT:-0}" ;;',
			'esac'
		].join('\n')
	);
	chmodSync(fakeDocker, 0o755);

	const wrapper = join(process.cwd(), 'scripts', 'run-synthetic-ui.sh').replace(/\\/g, '/');
	const result = spawnSync('bash', [wrapper], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${dockerDir.replace(/\\/g, '/')}:${process.env.PATH ?? ''}`,
			FAKE_DOCKER_EXIT: '7',
			FAKE_DOCKER_LOG: logFile,
			SYNTHETIC_REPORT_ROOT: reportRoot,
			SYNTHETIC_REPORT_KEEP_RUNS: '2',
			SYNTHETIC_UI_IMAGE: `ghcr.io/jmal1/selfservice-synthetic-ui:${'a'.repeat(40)}`
		}
	});

	expect(result.status, result.stderr).toBe(7);
	expect(result.stdout).toContain('[synthetic-ui] report output folder: ./playwright-report/runs/');
	expect(existsSync(outsideFile)).toBe(true);
	expect(existsSync(join(runsRoot, '20260825T143000Z-1004'))).toBe(true);
	expect(existsSync(join(runsRoot, '20260825T142000Z-1003'))).toBe(true);
	expect(existsSync(join(runsRoot, '20260825T141000Z-1002'))).toBe(true);
	expect(existsSync(join(runsRoot, '20260825T140000Z-1001'))).toBe(true);
	expect(result.stderr).not.toContain('report retention failed');
	const dockerCalls = readFileSync(logFile, 'utf8').trim().split('\n');
	expect(dockerCalls).toHaveLength(3);
	expect(dockerCalls[0]).toContain('deployment-guardrails.mjs preflight');
	expect(dockerCalls[1]).toContain('run --rm monitor');
	expect(dockerCalls[2]).toContain('deployment-guardrails.mjs prune 2');
	expect(result.stderr).toBe('');
	expect(result.stdout).toContain('report output folder');
	expect(result.stdout).not.toContain('node');
});

function createRunDir(root: string, name: string, ageMs: number): string {
	const runDir = join(root, name);
	mkdirSync(runDir, { recursive: true });
	const timestamp = new Date(Date.now() - ageMs);
	utimesSync(runDir, timestamp, timestamp);
	return runDir;
}
