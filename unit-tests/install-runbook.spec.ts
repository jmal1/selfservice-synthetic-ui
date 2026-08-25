/**
 * Load-bearing contract tests for the atomic host install runbook in README.md.
 *
 * These tests exist to prevent regressions introduced by PR #16 (live-host
 * rollout blocker):
 *   1. /opt/synthetic-ui/app/scripts must be created before the wrapper is
 *      installed there (the directory does not exist on first migration).
 *   2. WRAPPER_STAGE must be removed in cleanup together with the other staged
 *      files so /tmp is not left with a stale privileged artefact.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadReadme(): string {
	return readFileSync(join(process.cwd(), 'README.md'), 'utf8');
}

/**
 * Extract a fenced bash code block from the README that contains the given
 * anchor string. Returns the lines inside the fence.
 */
function extractBashBlock(readme: string, anchor: string): string[] {
	const lines = readme.split('\n');
	let inBlock = false;
	const block: string[] = [];
	for (const line of lines) {
		if (!inBlock && /^```bash/.test(line)) {
			inBlock = true;
			block.length = 0;
			continue;
		}
		if (inBlock && /^```/.test(line)) {
			inBlock = false;
			if (block.some((l) => l.includes(anchor))) {
				return block;
			}
			block.length = 0;
			continue;
		}
		if (inBlock) {
			block.push(line);
		}
	}
	return [];
}

test('install runbook creates /opt/synthetic-ui/app/scripts before installing the wrapper', () => {
	const readme = loadReadme();
	// Find the bash block that contains the wrapper install step.
	const block = extractBashBlock(readme, '/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(block.length, 'expected to find the install bash block in README.md').toBeGreaterThan(0);

	const installDirIdx = block.findIndex((l) =>
		/sudo install -d .*\/opt\/synthetic-ui\/app\/scripts/.test(l)
	);
	// Specifically find the install that writes to the scripts directory (not
	// the backup-section install that writes to $BACKUP/run-synthetic-ui.sh).
	const wrapperScriptInstallIdx = block.findIndex((l) =>
		l.includes('/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new')
	);

	expect(
		installDirIdx,
		'install runbook must create /opt/synthetic-ui/app/scripts with `sudo install -d` before installing the wrapper'
	).toBeGreaterThanOrEqual(0);

	expect(
		wrapperScriptInstallIdx,
		'install runbook must contain the install step writing to /opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new'
	).toBeGreaterThanOrEqual(0);

	expect(
		installDirIdx,
		'`install -d` for /opt/synthetic-ui/app/scripts must appear before the install into /opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new'
	).toBeLessThan(wrapperScriptInstallIdx);
});

test('install runbook cleanup removes WRAPPER_STAGE together with COMPOSE_STAGE and SERVICE_STAGE', () => {
	const readme = loadReadme();
	const block = extractBashBlock(readme, '/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(block.length, 'expected to find the install bash block in README.md').toBeGreaterThan(0);

	const cleanupLine = block.find((l) => l.includes('rm -f') && l.includes('COMPOSE_STAGE'));
	expect(
		cleanupLine,
		'install runbook must have a cleanup line that removes $COMPOSE_STAGE'
	).toBeDefined();

	expect(
		cleanupLine,
		'cleanup line must also remove $SERVICE_STAGE'
	).toContain('SERVICE_STAGE');

	expect(
		cleanupLine,
		'cleanup line must also remove $WRAPPER_STAGE to avoid leaving a stale staged file in /tmp'
	).toContain('WRAPPER_STAGE');
});
