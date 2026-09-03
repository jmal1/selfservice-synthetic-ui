import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
	expectedFullSuiteCheckCount,
	loadSyntheticConfig,
	parseBooleanEnv
} from '../tests/lib/config.ts';

test('boolean env defaults only when unset', () => {
	expect(parseBooleanEnv('FLAG', undefined, true)).toBe(true);
	expect(parseBooleanEnv('FLAG', undefined, false)).toBe(false);
});

test('boolean env accepts explicit true and false', () => {
	expect(parseBooleanEnv('FLAG', 'true', false)).toBe(true);
	expect(parseBooleanEnv('FLAG', 'false', true)).toBe(false);
});

test('invalid boolean env fails clearly', () => {
	expect(() => parseBooleanEnv('FLAG', '1', true)).toThrow(
		'FLAG must be exactly "true" or "false"; received "1"'
	);
	expect(() => parseBooleanEnv('FLAG', '', true)).toThrow(
		'FLAG must be exactly "true" or "false"; received ""'
	);
	expect(() => parseBooleanEnv('FLAG', ' TRUE ', false)).toThrow(
		'FLAG must be exactly "true" or "false"; received " TRUE "'
	);
	expect(() => parseBooleanEnv('FLAG', 'False', true)).toThrow(
		'FLAG must be exactly "true" or "false"; received "False"'
	);
});

test('lifecycle defaults enabled when its template is configured', () => {
	expect(loadSyntheticConfig({ SYNTHETIC_TEMPLATE_NAME: 'synthetic-noop' })).toEqual({
		lifecycleEnabled: true,
		expectMaintenance: false
	});
});

test('maintenance expectation requires lifecycle checks disabled', () => {
	expect(() =>
		loadSyntheticConfig({
			SYNTHETIC_LIFECYCLE_ENABLED: 'true',
			SYNTHETIC_EXPECT_MAINTENANCE: 'true',
			SYNTHETIC_TEMPLATE_NAME: 'synthetic-noop'
		})
	).toThrow('SYNTHETIC_EXPECT_MAINTENANCE=true requires SYNTHETIC_LIFECYCLE_ENABLED=false');
});

test('recovery enables lifecycle without expecting maintenance', () => {
	expect(
		loadSyntheticConfig({
			SYNTHETIC_LIFECYCLE_ENABLED: 'true',
			SYNTHETIC_EXPECT_MAINTENANCE: 'false',
			SYNTHETIC_TEMPLATE_NAME: 'synthetic-noop'
		})
	).toEqual({
		lifecycleEnabled: true,
		expectMaintenance: false
	});
});

test('enabled lifecycle fails configuration when its template is missing', () => {
	expect(() =>
		loadSyntheticConfig({
			SYNTHETIC_LIFECYCLE_ENABLED: 'true',
			SYNTHETIC_EXPECT_MAINTENANCE: 'false'
		})
	).toThrow(
		'SYNTHETIC_TEMPLATE_NAME must be set when SYNTHETIC_LIFECYCLE_ENABLED=true'
	);
});

test('full-suite expected count follows lifecycle, maintenance, and identity state', () => {
	expect(
		expectedFullSuiteCheckCount({
			SYNTHETIC_LIFECYCLE_ENABLED: 'true',
			SYNTHETIC_EXPECT_MAINTENANCE: 'false',
			SYNTHETIC_TEMPLATE_NAME: 'synthetic-noop',
			SYNTHETIC_ADMIN_USERNAME: 'admin',
			SYNTHETIC_ADMIN_PASSWORD: 'secret'
		})
	).toBe(25);
	expect(
		expectedFullSuiteCheckCount({
			SYNTHETIC_LIFECYCLE_ENABLED: 'false',
			SYNTHETIC_EXPECT_MAINTENANCE: 'true',
			SYNTHETIC_ADMIN_USERNAME: 'admin',
			SYNTHETIC_ADMIN_PASSWORD: 'secret'
		})
	).toBe(25);
	expect(
		expectedFullSuiteCheckCount({
			SYNTHETIC_LIFECYCLE_ENABLED: 'false',
			SYNTHETIC_EXPECT_MAINTENANCE: 'false',
			SYNTHETIC_TEMPLATE_NAME: 'synthetic-noop',
			SYNTHETIC_ADMIN_USERNAME: 'admin',
			SYNTHETIC_ADMIN_PASSWORD: 'secret'
		})
	).toBe(25);
	expect(
		expectedFullSuiteCheckCount({
			SYNTHETIC_LIFECYCLE_ENABLED: 'false',
			SYNTHETIC_EXPECT_MAINTENANCE: 'false'
		})
	).toBe(19);
});

test('README configured check-count table matches computed production configurations', () => {
	const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
	const documentedRows = [
		...readme.matchAll(/^\| `(true|false)`\s+\| `(true|false)`\s+\| (\d+)\s+\|$/gm)
	].map((match) => ({
		lifecycle: match[1],
		maintenance: match[2],
		count: Number(match[3])
	}));
	const credentials = {
		SYNTHETIC_TEMPLATE_NAME: 'synthetic-noop',
		SYNTHETIC_ADMIN_USERNAME: 'admin',
		SYNTHETIC_ADMIN_PASSWORD: 'secret'
	};
	const configurations = [
		{ lifecycle: 'true', maintenance: 'false' },
		{ lifecycle: 'false', maintenance: 'false' },
		{ lifecycle: 'false', maintenance: 'true' }
	];

	expect(documentedRows).toEqual(
		configurations.map(({ lifecycle, maintenance }) => ({
			lifecycle,
			maintenance,
			count: expectedFullSuiteCheckCount({
				...credentials,
				SYNTHETIC_LIFECYCLE_ENABLED: lifecycle,
				SYNTHETIC_EXPECT_MAINTENANCE: maintenance
			})
		}))
	);
});

test('package verify includes lint, unit, ownership, and non-mutating discovery steps', () => {
	const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
		scripts: Record<string, string>;
	};
	const verify = packageJson.scripts.verify;
	for (const step of [
		'npm run lint',
		'npm run test:unit',
		'npm run test:ownership',
		'node scripts/verify-playwright-list.mjs'
	]) {
		expect(verify).toContain(step);
	}
});

test('push builds publish an immutable image digest manifest for Compose', () => {
	const workflowText = readFileSync(join(process.cwd(), '.github/workflows/build.yml'), 'utf8');
	const workflow = asRecord(parse(workflowText));
	const concurrency = asRecord(workflow.concurrency);
	const triggers = asRecord(workflow.on);
	const push = asRecord(triggers.push);
	expect(push.branches).toEqual(['master', 'main']);
	expect(Object.prototype.hasOwnProperty.call(triggers, 'workflow_dispatch')).toBe(true);
	expect(concurrency.group).toBe(
		'${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}'
	);
	expect(concurrency.group).not.toContain('github.ref');
	expect(concurrency.group).toContain('github.run_id');
	expect(concurrency['cancel-in-progress']).toBe(true);

	const jobs = asRecord(workflow.jobs);
	const testJob = asRecord(jobs.test);
	const buildJob = asRecord(jobs['build-and-push']);
	expect(buildJob.if).toBe("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
	expect(testJob.steps).toContainEqual({ run: 'npm run verify' });
	if (!Array.isArray(buildJob.steps)) {
		throw new Error('build-and-push.steps must be an array');
	}
	const steps = buildJob.steps.map(asRecord);
	const metadata = steps.find((step) => step.uses === 'docker/metadata-action@v5');
	const build = steps.find((step) => step.uses === 'docker/build-push-action@v5');
	const publishShaTag = steps.find((step) => step.name === 'Assert commit SHA tag was published');
	const writeManifest = steps.find((step) => step.name === 'Write image digest manifest');
	const uploadManifest = steps.find((step) => step.uses === 'actions/upload-artifact@v4');

	expect(asRecord(metadata?.with).tags).toContain('type=raw,value=${{ github.sha }}');
	expect(asRecord(metadata?.with).labels).toContain(
		'org.opencontainers.image.revision=${{ github.sha }}'
	);
	expect(build?.id).toBe('build');
	expect(asRecord(build?.with).push).toBe(true);
	expect(publishShaTag?.run).toBe(
		'docker buildx imagetools inspect ghcr.io/${{ github.repository }}:${{ github.sha }} >/dev/null'
	);
	expect(writeManifest?.if).toBeUndefined();
	expect(writeManifest?.run).toBe(
		'node scripts/write-image-digest-manifest.mjs image-digest-synthetic-ui.tsv'
	);
	expect(asRecord(writeManifest?.env)).toEqual({
		IMAGE_DIGEST: '${{ steps.build.outputs.digest }}',
		SOURCE_SHA: '${{ github.sha }}'
	});
	expect(uploadManifest?.if).toBeUndefined();
	expect(asRecord(uploadManifest?.with)).toMatchObject({
		name: 'image-digest-synthetic-ui',
		path: 'image-digest-synthetic-ui.tsv',
		'if-no-files-found': 'error'
	});

	const compose = asRecord(
		parse(readFileSync(join(process.cwd(), 'deploy/docker-compose.yml'), 'utf8'))
	);
	const services = asRecord(compose.services);
	const monitor = asRecord(services.monitor);
	const service = readFileSync(join(process.cwd(), 'deploy/synthetic-ui.service'), 'utf8');
	const wrapper = readFileSync(join(process.cwd(), 'scripts/run-synthetic-ui.sh'), 'utf8');
	const guardrails = readFileSync(join(process.cwd(), 'scripts/deployment-guardrails.mjs'), 'utf8');
	const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
	const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
	expect(monitor.image).toBe(
		'${SYNTHETIC_UI_IMAGE:?SYNTHETIC_UI_IMAGE must be an immutable ghcr.io/jmal1/selfservice-synthetic-ui:<40-character lowercase commit SHA> tag}'
	);
	expect(String(monitor.image)).not.toContain(':latest');
	expect(service).toContain('EnvironmentFile=/opt/synthetic-ui/image.env');
	expect(service).toContain('EnvironmentFile=/opt/synthetic-ui/runtime.env');
	expect(service).not.toContain('EnvironmentFile=-/opt/synthetic-ui/runtime.env');
	expect(service).toContain('Environment=SYNTHETIC_EXPECT_MAINTENANCE=false');
	expect(service).not.toContain('Environment=SYNTHETIC_EXPECT_MAINTENANCE=true');
	expect(service).not.toContain('SYNTHETIC_REPORT_ROOT');
	expect(service).toContain('Environment=SYNTHETIC_REPORT_KEEP_RUNS=3');
	expect(service).toContain('ExecStart=/usr/bin/bash /opt/synthetic-ui/app/scripts/run-synthetic-ui.sh');
	expect(service).not.toContain('/usr/bin/node');
	expect(wrapper).toContain('set -euo pipefail');
	expect(wrapper).toContain('docker compose -f "$compose_file" run --rm monitor');
	expect(wrapper).toContain(
		'^ghcr\\.io/jmal1/selfservice-synthetic-ui:[0-9a-f]{40}$'
	);
	expect(wrapper).toContain('/app/scripts/deployment-guardrails.mjs "$@"');
	expect(wrapper).toContain('readonly report_root="/opt/synthetic-ui/report"');
	expect(wrapper).toContain('readonly results_root="/opt/synthetic-ui/results"');
	expect(wrapper).not.toContain('SYNTHETIC_REPORT_ROOT');
	expect(wrapper).toContain('exit "$run_status"');
	expect(guardrails).toContain('unexpected non-directory entry under');
	expect(guardrails).toContain('container report commands must run as pwuser UID 1001');
	expect(dockerfile).toContain(
		'COPY scripts/deployment-guardrails.mjs ./scripts/deployment-guardrails.mjs'
	);
	expect(asRecord(monitor.environment).SYNTHETIC_EXPECT_MAINTENANCE).toBe(
		'${SYNTHETIC_EXPECT_MAINTENANCE:-false}'
	);
	expect(asRecord(monitor.environment).PLAYWRIGHT_REPORT_RUN_ID).toBe(
		'${PLAYWRIGHT_REPORT_RUN_ID:-latest}'
	);
	const productionVolumes = [
		'/opt/synthetic-ui/results:/app/test-results',
		'/opt/synthetic-ui/report:/app/playwright-report'
	];
	expect(monitor.volumes).toEqual(productionVolumes);
	const wrapperBindSources = [...wrapper.matchAll(
		/^readonly (?:report|results)_root="([^"]+)"$/gm
	)].map((match) => match[1]).sort();
	expect(wrapperBindSources).toEqual(
		productionVolumes.map((volume) => volume.split(':', 1)[0]).sort()
	);
	expect(readme.match(/^set -euo pipefail$/gm)).toHaveLength(3);
	expect(
		readme.match(
			/^SERVICE_RESULT="\$\(systemctl show synthetic-ui\.service -p Result --value\)"$/gm
		)
	).toHaveLength(3);
	expect(readme.match(/^test "\$SERVICE_RESULT" = success$/gm)).toHaveLength(3);
	expect(readme.match(/^test "\$SERVICE_STATUS" = 0$/gm)).toHaveLength(3);
	expect(readme).toContain('test "$RESOLVED_IMAGE" = "$ROLLBACK_IMAGE"');
	expect(readme).toContain('ROLLBACK_IMAGE_ID="$(sudo cat "$BACKUP/previous-image-id")"');
	expect(readme).toContain('test "$LOCAL_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"');
	expect(readme).toContain('test "$RESOLVED_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"');
	expect(
		readme.match(
			/^\s*STATE="\$\(systemctl show synthetic-ui\.service -p ActiveState --value\)"$/gm
		)
	).toHaveLength(4);
	expect(readme).not.toContain('while STATE="$(systemctl show');
	expect(readme.match(/^sudo systemctl disable --now synthetic-ui\.timer$/gm)).toHaveLength(3);
	expect(readme.match(/^sudo systemctl enable --now synthetic-ui\.timer$/gm)).toHaveLength(1);
	expect(readme).not.toContain('sudo systemctl start synthetic-ui.timer');
	expect(readme.match(/^test "\$TIMER_UNIT_STATE" = disabled$/gm)).toHaveLength(3);
	expect(readme.match(/^test "\$TIMER_ACTIVE_STATE" = inactive$/gm)).toHaveLength(3);
	expect(readme).toContain('test "$STORAGE_STALE_HANDLE_RATE" = 0');
	expect(readme).toContain('test "$APD_COUNT" = 0');
	expect(readme).toContain('test "$UI_CHECKS" = green');
	expect(readme).toContain('the deploy contract uses that full SHA reference');
	expect(readme).toContain('$Wrapper = Join-Path $Work \'scripts\\run-synthetic-ui.sh\'');
	expect(readme).toContain('$WrapperHash = (Get-FileHash -Algorithm SHA256 $Wrapper).Hash.ToLower()');
	expect(readme).toContain("WRAPPER_SHA256='<printed lowercase hash>'");
	expect(readme).toContain('$WRAPPER_STAGE = "/tmp/run-synthetic-ui.$SourceSha.sh"');
	expect(readme).toContain('test -f "$WRAPPER_STAGE"');
	expect(readme).toContain('$Image = "$($Fields[1]):$SourceSha"');
	expect(readme).toContain('scp $Wrapper "jmal@192.168.68.95:$WRAPPER_STAGE"');
	expect(readme).toContain('"WRAPPER_SHA256=$WrapperHash"');
	expect(readme).toContain('[[ "$WRAPPER_SHA256" =~ ^[0-9a-f]{64}$ ]]');
	expect(readme).toContain('printf \'%s  %s\\n\' "$WRAPPER_SHA256" "$WRAPPER_STAGE" | sha256sum -c -');
	expect(readme).toContain(
		'[[ "$PREVIOUS_IMAGE" =~ ^ghcr\\.io/jmal1/selfservice-synthetic-ui:[0-9a-f]{40}$ ]]'
	);
	expect(readme).toContain("PREVIOUS_IMAGE='ghcr.io/jmal1/selfservice-synthetic-ui@sha256:<operator-supplied current image digest>'");
	expect(readme).toContain(
		'[[ "$PREVIOUS_IMAGE" =~ ^ghcr\\.io/jmal1/selfservice-synthetic-ui@sha256:[0-9a-f]{64}$ ]]'
	);
	expect(readme).toContain('PREVIOUS_IMAGE_ID="$(sudo docker image inspect \\');
	expect(readme).toContain('validate_runtime "$BACKUP/runtime.env" false');
	expect(readme).toMatch(
		/Both modes prove the exact[\s\S]*pinned-upgrade rollback runs one[\s\S]*direct Compose canary/
	);
	expect(readme).toContain(
		'Containment rollback only: keep the new unit/wrapper and do not start it.'
	);
	expect(readme.match(/^\s*sudo systemctl start synthetic-ui\.service$/gm)).toHaveLength(2);
	expect(readme).toContain('/opt/synthetic-ui/report/runs/<run-id>');
	expect(readme).toContain('keeps only the newest three runs');
	expect(readme).toContain('The host launcher is a Bash wrapper');
	expect(readme).toContain('without requiring `/usr/bin/node`');
	expect(readme).toContain('/opt/synthetic-ui/report/runs/');
	expect(readme).toContain('if sudo test -f /opt/synthetic-ui/image.env; then');
	expect(readme).toContain('INSTALL_MODE=pinned');
	expect(readme).toContain('INSTALL_MODE=first-migration');
	expect(readme).toContain('test "$CURRENT_RESOLVED_IMAGE" = "$PREVIOUS_IMAGE"');
	expect(readme).toContain('test "$CURRENT_IMAGE_ID" = "$PREVIOUS_IMAGE_ID"');
	expect(readme).toContain('sudo cp -a /opt/synthetic-ui/app/scripts/run-synthetic-ui.sh "$BACKUP/run-synthetic-ui.sh"');
	expect(readme).toContain('sudo install -m 0755 "$WRAPPER_STAGE" "$BACKUP/run-synthetic-ui.sh"');
	expect(readme).toContain('sudo test -f "$BACKUP/run-synthetic-ui.sh"');
	expect(readme).toContain('sudo install -m 0755 "$WRAPPER_STAGE"');
	expect(readme).toContain('sudo install -m 0755 "$BACKUP/run-synthetic-ui.sh"');
	expect(readme).toContain('sudo mv /opt/synthetic-ui/app/scripts/run-synthetic-ui.sh.new');
	expect(readme).toContain('sudo tee "$BACKUP/image.env" >/dev/null');
	expect(readme).toContain('sudo cp -a /opt/synthetic-ui/source.sha "$BACKUP/source.sha"');
	expect(readme).toContain('sudo cp -a /opt/synthetic-ui/runtime.env "$BACKUP/runtime.env"');
	expect(readme).toContain("sudo tee \"$BACKUP/runtime.env\" >/dev/null");
	expect(readme).toContain('INSTALL_MODE="$(sudo cat "$BACKUP/install-mode")"');
	expect(readme).toContain('if [ "$INSTALL_MODE" = first-migration ]; then');
	expect(readme).toContain('elif [ "$INSTALL_MODE" = pinned ]; then');
	expect(readme).toContain('sudo install -m 0644 "$BACKUP/docker-compose.yml"');
	expect(readme).toContain('sudo install -m 0644 "$BACKUP/synthetic-ui.service"');
	expect(readme).toContain('sudo tee /opt/synthetic-ui/source.sha.new >/dev/null');
	expect(readme).toContain(
		'sudo install -m 0644 "$BACKUP/runtime.env" /opt/synthetic-ui/runtime.env.new'
	);
	expect(readme.match(/^validate_runtime\(\) \{$/gm)).toHaveLength(3);
	expect(
		readme.match(
			/^\s*'SYNTHETIC_LIFECYCLE_ENABLED=%s\\nSYNTHETIC_EXPECT_MAINTENANCE=false\\n' "\$2" \|$/gm
		)
	).toHaveLength(3);
	expect(readme).not.toContain("grep -qx 'SYNTHETIC_LIFECYCLE_ENABLED=false'");
	expect(readme).toContain(
		"'SYNTHETIC_LIFECYCLE_ENABLED=%s\\nSYNTHETIC_EXPECT_MAINTENANCE=false\\n' \"$1\" |"
	);
	expect(
		readme.match(
			/printf 'SYNTHETIC_LIFECYCLE_ENABLED=false\\nSYNTHETIC_EXPECT_MAINTENANCE=false\\n' \|/g
		)
	).toHaveLength(2);
	expect(readme).toContain('trap restore_containment ERR');
	expect(readme).toContain('restore_containment() {');
	const cleanupStart = readme.indexOf('restore_containment() {');
	const cleanupEnd = readme.indexOf('\n}\n', cleanupStart);
	const cleanup = readme.slice(cleanupStart, cleanupEnd);
	expect(cleanup).toContain('if ! sudo systemctl disable --now synthetic-ui.timer; then');
	expect(cleanup).toContain('if ! set_lifecycle false; then');
	expect(cleanup).toContain('MANUAL INTERVENTION REQUIRED');
	expect(cleanup.indexOf('if ! sudo systemctl disable')).toBeLessThan(
		cleanup.indexOf('if ! set_lifecycle false')
	);
	expect(readme).toContain('set_lifecycle true');
	expect(readme).toContain('test "$POST_LIFECYCLE_STORAGE_STALE_HANDLE_RATE" = 0');
	expect(readme).toContain('test "$POST_LIFECYCLE_APD_COUNT" = 0');
	expect(readme.indexOf('test "$POST_LIFECYCLE_APD_COUNT" = 0')).toBeLessThan(
		readme.indexOf('sudo systemctl enable --now synthetic-ui.timer')
	);

	const digest = `sha256:${'a'.repeat(64)}`;
	const sourceSha = 'b'.repeat(40);
	const tempDirectory = mkdtempSync(join(tmpdir(), 'synthetic-ui-manifest-'));
	const outputPath = join(tempDirectory, 'image-digest-synthetic-ui.tsv');
	try {
		execFileSync(
			process.execPath,
			[join(process.cwd(), 'scripts/write-image-digest-manifest.mjs'), outputPath],
			{
				env: { ...process.env, IMAGE_DIGEST: digest, SOURCE_SHA: sourceSha }
			}
		);
		const manifest = readFileSync(outputPath, 'utf8');
		expect(manifest).toBe(
			`synthetic-ui\tghcr.io/jmal1/selfservice-synthetic-ui\t${digest}\t${sourceSha}\n`
		);
		expect(manifest.trimEnd().split('\t')).toEqual([
			'synthetic-ui',
			'ghcr.io/jmal1/selfservice-synthetic-ui',
			digest,
			sourceSha
		]);
		expect(manifest.split('\n')).toHaveLength(2);
	} finally {
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('expected a mapping');
	}
	return value as Record<string, unknown>;
}
