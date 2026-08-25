import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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

function createRunDir(root: string, name: string, ageMs: number): string {
	const runDir = join(root, name);
	mkdirSync(runDir, { recursive: true });
	const timestamp = new Date(Date.now() - ageMs);
	utimesSync(runDir, timestamp, timestamp);
	return runDir;
}
