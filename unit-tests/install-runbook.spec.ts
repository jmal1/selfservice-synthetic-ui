/**
 * Load-bearing contract tests for the atomic host install runbook in README.md.
 *
 * These tests exist to prevent regressions introduced by PR #16 (live-host
 * rollout blocker):
 *   1. /opt/synthetic-ui/app/scripts must be created before the wrapper is
 *      installed there (the directory does not exist on first migration).
 *   2. WRAPPER_STAGE must be removed in cleanup together with the other staged
 *      files so /tmp is not left with a stale privileged artefact.
 *
 * Additional tests cover:
 *   - Windows staging: core.autocrlf=false configured before checkout (LF bytes)
 *   - Windows staging: CR byte rejection for all three staged text assets
 *   - Host preflight: bash -n syntax check ordered after checksums, before install
 *   - Install mode: SHA tag → pinned upgrade vs immutable digest → first-migration retry
 *   - Digest retry: validate_runtime + docker image inspect + Compose resolve proofs
 *   - Invalid pin format: fail closed with exit 1
 *   - Host preflight: recursively repair report/runs/results for UID 1001
 *   - Bash wrapper: host UID writability is not confused with container UID access
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

/**
 * Extract a fenced powershell code block from the README that contains the
 * given anchor string. Returns the lines inside the fence.
 */
function extractPowerShellBlock(readme: string, anchor: string): string[] {
	const lines = readme.split('\n');
	let inBlock = false;
	const block: string[] = [];
	for (const line of lines) {
		if (!inBlock && /^```powershell/.test(line)) {
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

// ---------------------------------------------------------------------------
// Windows staging: LF byte guarantee
// ---------------------------------------------------------------------------

test('Windows staging configures core.autocrlf=false before checkout to prevent CRLF line endings', () => {
	const readme = loadReadme();
	const block = extractPowerShellBlock(readme, 'checkout --detach');
	expect(block.length, 'expected to find the Windows staging PowerShell block').toBeGreaterThan(0);

	const cloneIdx = block.findIndex((l) => l.includes('clone --no-checkout'));
	const autocrlfIdx = block.findIndex((l) => l.includes('config core.autocrlf false'));
	const checkoutIdx = block.findIndex((l) => l.includes('checkout --detach'));

	expect(cloneIdx, 'staging block must use git clone --no-checkout').toBeGreaterThanOrEqual(0);
	expect(
		autocrlfIdx,
		'staging block must configure core.autocrlf false so checkout writes LF repository bytes'
	).toBeGreaterThanOrEqual(0);
	expect(checkoutIdx, 'staging block must include git checkout --detach').toBeGreaterThanOrEqual(0);

	expect(
		cloneIdx,
		'git clone --no-checkout must appear before core.autocrlf config'
	).toBeLessThan(autocrlfIdx);
	expect(
		autocrlfIdx,
		'core.autocrlf=false must be configured before checkout --detach writes any files'
	).toBeLessThan(checkoutIdx);
});

test('Windows staging rejects CR bytes in all three staged text assets before SCP transfer', () => {
	const readme = loadReadme();
	const block = extractPowerShellBlock(readme, 'scp');
	expect(block.length, 'expected to find the Windows staging PowerShell block with SCP').toBeGreaterThan(0);

	// Must contain a numeric 13 (CR byte value) or an explicit 0x0D literal check.
	const crCheckIdx = block.findIndex((l) => /\b13\b|0x0[Dd]/.test(l));
	expect(
		crCheckIdx,
		'staging block must include a CR byte (decimal 13 / 0x0D) rejection check'
	).toBeGreaterThanOrEqual(0);

	// The loop must cover all three staged file variables.
	const rejectionArea = block.join('\n');
	expect(rejectionArea, 'CR rejection must reference $Compose').toContain('Compose');
	expect(rejectionArea, 'CR rejection must reference $Service').toContain('Service');
	expect(rejectionArea, 'CR rejection must reference $Wrapper').toContain('Wrapper');

	// CR rejection must appear before any scp transfer line.
	const scpIdx = block.findIndex((l) => /^\s*scp\b/.test(l));
	expect(scpIdx, 'staging block must include scp transfer step').toBeGreaterThanOrEqual(0);
	expect(
		crCheckIdx,
		'CR byte rejection must appear before SCP transfer so a CRLF-transformed file is never transferred to the host'
	).toBeLessThan(scpIdx);
});

// ---------------------------------------------------------------------------
// Host preflight: bash -n ordering
// ---------------------------------------------------------------------------

test('host preflight validates wrapper bash syntax after checksums but before any file installation', () => {
	const readme = loadReadme();
	const block = extractBashBlock(readme, '/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(block.length, 'expected to find the host install bash block').toBeGreaterThan(0);

	// Find the last sha256sum -c line index.
	const sha256Indices = block
		.map((l, i) => ({ l, i }))
		.filter(({ l }) => l.includes('sha256sum -c'));
	expect(sha256Indices.length, 'install block must have sha256sum -c checksum lines').toBeGreaterThan(0);
	const lastSha256Idx = sha256Indices[sha256Indices.length - 1].i;

	// bash -n syntax check on the wrapper stage.
	const bashNIdx = block.findIndex((l) => /bash\s+-n\s+.*WRAPPER_STAGE/.test(l));
	expect(
		bashNIdx,
		'install block must include bash -n "$WRAPPER_STAGE" to catch CRLF wrappers before installation'
	).toBeGreaterThanOrEqual(0);

	// The load-bearing ordering contract: bash -n must occur AFTER all checksums
	// and BEFORE the wrapper is atomically installed to its final target path.
	// The install command spans two lines; find the line with the target path.
	const wrapperInstallIdx = block.findIndex((l) =>
		l.includes('run-synthetic-ui.sh.new') && !l.includes('$BACKUP')
	);
	expect(wrapperInstallIdx, 'install block must have the wrapper atomic install target path').toBeGreaterThanOrEqual(0);

	expect(
		lastSha256Idx,
		'bash -n syntax check must come after all sha256sum -c checksum verifications'
	).toBeLessThan(bashNIdx);
	expect(
		bashNIdx,
		'bash -n syntax check must come before the wrapper is atomically installed to run-synthetic-ui.sh.new'
	).toBeLessThan(wrapperInstallIdx);
});

// ---------------------------------------------------------------------------
// Install mode classification
// ---------------------------------------------------------------------------

test('install mode classifies existing full-SHA tag as pinned upgrade', () => {
	const readme = loadReadme();
	const block = extractBashBlock(readme, '/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(block.length, 'expected to find the host install bash block').toBeGreaterThan(0);

	// SHA-tag regex must appear before or at the INSTALL_MODE=pinned assignment.
	const shaTagIdx = block.findIndex((l) =>
		l.includes('selfservice-synthetic-ui:[0-9a-f]{40}')
	);
	const pinnedIdx = block.findIndex((l) => l.includes('INSTALL_MODE=pinned'));

	expect(shaTagIdx, 'install block must match the SHA-tag image format').toBeGreaterThanOrEqual(0);
	expect(pinnedIdx, 'install block must set INSTALL_MODE=pinned').toBeGreaterThanOrEqual(0);
	expect(
		shaTagIdx,
		'SHA-tag regex must appear at or before INSTALL_MODE=pinned'
	).toBeLessThanOrEqual(pinnedIdx);
});

test('install mode classifies existing immutable digest as first-migration containment retry, not pinned', () => {
	const readme = loadReadme();
	const block = extractBashBlock(readme, '/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(block.length, 'expected to find the host install bash block').toBeGreaterThan(0);

	// Must have an elif/conditional branch that matches the digest format.
	const digestBranchIdx = block.findIndex((l) =>
		l.includes('selfservice-synthetic-ui@sha256:[0-9a-f]{64}') &&
		/elif|^\[\[/.test(l)
	);
	expect(
		digestBranchIdx,
		'install block must have a separate branch matching the immutable digest format (@sha256:[0-9a-f]{64})'
	).toBeGreaterThanOrEqual(0);

	// Within the digest branch, INSTALL_MODE=first-migration must appear.
	const afterDigest = block.slice(digestBranchIdx);
	const firstMigrationInBranch = afterDigest.findIndex((l) =>
		l.includes('INSTALL_MODE=first-migration')
	);
	expect(
		firstMigrationInBranch,
		'digest branch must set INSTALL_MODE=first-migration (not pinned)'
	).toBeGreaterThanOrEqual(0);

	// INSTALL_MODE=pinned must NOT appear inside the digest branch (before the next elif/else/fi).
	const endOfDigestBranch = afterDigest.findIndex(
		(l, i) => i > 0 && /^\s*(elif|else|fi)\b/.test(l)
	);
	const digestBranchBody =
		endOfDigestBranch >= 0 ? afterDigest.slice(0, endOfDigestBranch) : afterDigest;
	expect(
		digestBranchBody.some((l) => l.includes('INSTALL_MODE=pinned')),
		'digest branch must NOT set INSTALL_MODE=pinned'
	).toBe(false);
});

test('digest retry branch proves runtime=false, digest exists locally, and Compose resolves to it', () => {
	const readme = loadReadme();
	const block = extractBashBlock(readme, '/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(block.length, 'expected to find the host install bash block').toBeGreaterThan(0);

	const digestBranchIdx = block.findIndex((l) =>
		l.includes('selfservice-synthetic-ui@sha256:[0-9a-f]{64}') &&
		/elif|^\[\[/.test(l)
	);
	expect(digestBranchIdx, 'digest branch must be present').toBeGreaterThanOrEqual(0);

	const afterDigest = block.slice(digestBranchIdx);
	const endOfBranch = afterDigest.findIndex(
		(l, i) => i > 0 && /^\s*(elif|else|fi)\b/.test(l)
	);
	const branchBody =
		(endOfBranch >= 0 ? afterDigest.slice(0, endOfBranch) : afterDigest).join('\n');

	expect(branchBody, 'digest retry must validate runtime=false via validate_runtime').toContain(
		'validate_runtime'
	);
	expect(
		branchBody,
		'digest retry must prove digest exists locally via docker image inspect'
	).toContain('docker image inspect');
	expect(
		branchBody,
		'digest retry must prove Compose resolves to the digest via docker compose'
	).toContain('docker compose');
	expect(
		branchBody,
		'digest retry must verify Compose-resolved image equals PREVIOUS_IMAGE'
	).toContain('CURRENT_RESOLVED_IMAGE');
});

test('install mode fails closed with exit 1 on invalid pin format in image.env', () => {
	const readme = loadReadme();
	const block = extractBashBlock(readme, '/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(block.length, 'expected to find the host install bash block').toBeGreaterThan(0);

	// Find an else block (not elif) that is followed by exit 1 before the next fi.
	const elseIdx = block.findIndex((l, i) => {
		if (!/^\s*else\s*$/.test(l)) return false;
		const after = block.slice(i + 1);
		const nextFi = after.findIndex((al) => /^\s*fi\s*$/.test(al));
		const range = nextFi >= 0 ? after.slice(0, nextFi) : after;
		return range.some((al) => /\bexit 1\b/.test(al));
	});

	expect(
		elseIdx,
		'install block must have an else branch with exit 1 to fail closed on unrecognised pin formats'
	).toBeGreaterThanOrEqual(0);
});

// ---------------------------------------------------------------------------
// Report root ownership: runbook check
// ---------------------------------------------------------------------------

test('install runbook initializes runs and recursively repairs report/results ownership before canary', () => {
	const readme = loadReadme();
	const block = extractBashBlock(readme, '/opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(block.length, 'expected to find the host install bash block').toBeGreaterThan(0);

	const installIdx = block.findIndex((l) => l.includes('sudo install -d -m 0755 -o 1001 -g 1001'));
	const installCommand = block.slice(installIdx, installIdx + 2).join(' ');
	expect(installIdx, 'install runbook must initialize bind-mount roots').toBeGreaterThanOrEqual(0);
	expect(installCommand).toContain('/opt/synthetic-ui/report/runs');
	expect(installCommand).toContain('/opt/synthetic-ui/results');

	const chownIdx = block.findIndex((l) =>
		l.includes('sudo chown -R --no-dereference 1001:1001')
	);
	const chownCommand = block.slice(chownIdx, chownIdx + 2).join(' ');
	expect(
		chownIdx,
		'install runbook must recursively repair report and results trees for UID 1001'
	).toBeGreaterThanOrEqual(0);
	expect(chownCommand).toContain('/opt/synthetic-ui/report');
	expect(chownCommand).toContain('/opt/synthetic-ui/results');

	// The canary is sudo systemctl start synthetic-ui.service.
	const canaryIdx = block.findIndex((l) => /sudo systemctl start synthetic-ui\.service/.test(l));
	expect(canaryIdx, 'install runbook must start the canary service').toBeGreaterThanOrEqual(0);
	expect(
		chownIdx,
		'recursive ownership repair must appear before the canary systemctl start'
	).toBeLessThan(canaryIdx);
});

test('one-time setup recursively assigns report and results trees to UID 1001', () => {
	const block = extractBashBlock(loadReadme(), '/opt/synthetic-ui/{secrets,app,results,report/runs}');
	expect(block.length, 'expected to find the one-time setup block').toBeGreaterThan(0);
	const chownIdx = block.findIndex((line) =>
		line.includes('sudo chown -R --no-dereference 1001:1001')
	);
	const command = block.slice(chownIdx, chownIdx + 2).join(' ');
	expect(chownIdx).toBeGreaterThanOrEqual(0);
	expect(command).toContain('/opt/synthetic-ui/report');
	expect(command).toContain('/opt/synthetic-ui/results');
});

// ---------------------------------------------------------------------------
// Bash wrapper: report root preflight — load-bearing runtime tests
// ---------------------------------------------------------------------------

test('bash host wrapper rejects a missing report root before invoking Docker', () => {
	const root = mkdtempSync(join(tmpdir(), 'synthetic-ui-no-report-'));
	const dockerDir = join(root, 'bin');
	const logFile = join(root, 'docker.log');
	mkdirSync(dockerDir, { recursive: true });
	// Intentionally do NOT create the report directory.
	const reportRoot = join(root, 'report-missing');

	const fakeDocker = join(dockerDir, 'docker');
	writeFileSync(
		fakeDocker,
		['#!/usr/bin/env bash', 'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"', 'exit 0'].join('\n')
	);
	chmodSync(fakeDocker, 0o755);

	const wrapper = join(process.cwd(), 'scripts', 'run-synthetic-ui.sh').replace(/\\/g, '/');
	const result = spawnSync('bash', [wrapper], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${dockerDir.replace(/\\/g, '/')}:${process.env.PATH ?? ''}`,
			FAKE_DOCKER_LOG: logFile,
			SYNTHETIC_REPORT_ROOT: reportRoot,
			SYNTHETIC_UI_IMAGE: `ghcr.io/jmal1/selfservice-synthetic-ui:${'a'.repeat(40)}`
		}
	});

	expect(result.status, 'wrapper must exit non-zero when report root is missing').not.toBe(0);
	expect(result.stderr, 'wrapper must print a diagnostic for the missing report root').toMatch(
		/report root/i
	);
	// Docker must NOT have been invoked.
	expect(existsSync(logFile), 'Docker must not be invoked when report root is missing').toBe(false);
});

test('bash host wrapper delegates writability checks instead of testing as the host UID', () => {
	const root = mkdtempSync(join(tmpdir(), 'synthetic-ui-unwritable-'));
	const dockerDir = join(root, 'bin');
	const logFile = join(root, 'docker.log');
	const reportRoot = join(root, 'report');
	mkdirSync(dockerDir, { recursive: true });
	mkdirSync(reportRoot, { recursive: true });
	// The systemd host UID cannot write a correct UID 1001-owned 0755 root.
	chmodSync(reportRoot, 0o555);

	const fakeDocker = join(dockerDir, 'docker');
	writeFileSync(
		fakeDocker,
		['#!/usr/bin/env bash', 'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"', 'exit 0'].join('\n')
	);
	chmodSync(fakeDocker, 0o755);

	const wrapper = join(process.cwd(), 'scripts', 'run-synthetic-ui.sh').replace(/\\/g, '/');
	const result = spawnSync('bash', [wrapper], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${dockerDir.replace(/\\/g, '/')}:${process.env.PATH ?? ''}`,
			FAKE_DOCKER_LOG: logFile,
			SYNTHETIC_REPORT_ROOT: reportRoot,
			SYNTHETIC_UI_IMAGE: `ghcr.io/jmal1/selfservice-synthetic-ui:${'a'.repeat(40)}`
		}
	});

	// Restore so the tmp cleanup can remove the dir.
	chmodSync(reportRoot, 0o755);

	expect(result.status, result.stderr).toBe(0);
	const dockerCalls = readFileSync(logFile, 'utf8').trim().split('\n');
	expect(dockerCalls).toHaveLength(3);
	expect(dockerCalls[0]).toContain('deployment-guardrails.mjs preflight');
	expect(dockerCalls[1]).toContain('run --rm monitor');
	expect(dockerCalls[2]).toContain('deployment-guardrails.mjs prune 3');
});
