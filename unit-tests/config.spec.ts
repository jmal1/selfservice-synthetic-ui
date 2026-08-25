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
	).toBe(21);
	expect(
		expectedFullSuiteCheckCount({
			SYNTHETIC_LIFECYCLE_ENABLED: 'false',
			SYNTHETIC_EXPECT_MAINTENANCE: 'true',
			SYNTHETIC_ADMIN_USERNAME: 'admin',
			SYNTHETIC_ADMIN_PASSWORD: 'secret'
		})
	).toBe(21);
	expect(
		expectedFullSuiteCheckCount({
			SYNTHETIC_LIFECYCLE_ENABLED: 'false',
			SYNTHETIC_EXPECT_MAINTENANCE: 'false'
		})
	).toBe(16);
});

test('push builds publish an immutable image digest manifest for Compose', () => {
	const workflowText = readFileSync(join(process.cwd(), '.github/workflows/build.yml'), 'utf8');
	const workflow = asRecord(parse(workflowText));
	const triggers = asRecord(workflow.on);
	const push = asRecord(triggers.push);
	expect(push.branches).toEqual(['master', 'main']);

	const jobs = asRecord(workflow.jobs);
	const buildJob = asRecord(jobs['build-and-push']);
	expect(buildJob.if).toBe("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
	if (!Array.isArray(buildJob.steps)) {
		throw new Error('build-and-push.steps must be an array');
	}
	const steps = buildJob.steps.map(asRecord);
	const metadata = steps.find((step) => step.uses === 'docker/metadata-action@v5');
	const build = steps.find((step) => step.uses === 'docker/build-push-action@v5');
	const writeManifest = steps.find((step) => step.name === 'Write image digest manifest');
	const uploadManifest = steps.find((step) => step.uses === 'actions/upload-artifact@v4');

	expect(asRecord(metadata?.with).tags).toContain('type=raw,value=${{ github.sha }}');
	expect(asRecord(metadata?.with).labels).toContain(
		'org.opencontainers.image.revision=${{ github.sha }}'
	);
	expect(build?.id).toBe('build');
	expect(asRecord(build?.with).push).toBe(true);
	expect(writeManifest?.if).toBe("github.event_name == 'push'");
	expect(writeManifest?.run).toBe(
		'node scripts/write-image-digest-manifest.mjs image-digest-synthetic-ui.tsv'
	);
	expect(asRecord(writeManifest?.env)).toEqual({
		IMAGE_DIGEST: '${{ steps.build.outputs.digest }}',
		SOURCE_SHA: '${{ github.sha }}'
	});
	expect(uploadManifest?.if).toBe("github.event_name == 'push'");
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
	expect(monitor.image).toBe(
		'${SYNTHETIC_UI_IMAGE:-ghcr.io/jmal1/selfservice-synthetic-ui:latest}'
	);
	expect(service).toContain('EnvironmentFile=/opt/synthetic-ui/image.env');

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
