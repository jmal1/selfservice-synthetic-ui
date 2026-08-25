import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
	const workflow = readFileSync(join(process.cwd(), '.github/workflows/build.yml'), 'utf8');
	const compose = readFileSync(join(process.cwd(), 'deploy/docker-compose.yml'), 'utf8');

	expect(workflow).toContain("branches: [master, main]");
	expect(workflow).toContain("id: build");
	expect(workflow).toContain("IMAGE_DIGEST: ${{ steps.build.outputs.digest }}");
	expect(workflow).toContain("SOURCE_SHA: ${{ github.sha }}");
	expect(workflow).toContain('[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]');
	expect(workflow).toContain('[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]');
	expect(workflow).toContain(
		"printf 'component\\trepository\\tdigest\\tsource_sha\\n' > image-digest-synthetic-ui.tsv"
	);
	expect(workflow).toContain(
		"'synthetic-ui\\tghcr.io/jmal1/selfservice-synthetic-ui\\t%s\\t%s\\n'"
	);
	expect(workflow.match(/^\s+if: github\.event_name == 'push'\s*$/gm)).toHaveLength(2);
	expect(workflow).toContain("name: image-digest-synthetic-ui");
	expect(compose).toContain(
		'image: "${SYNTHETIC_UI_IMAGE:-ghcr.io/jmal1/selfservice-synthetic-ui:latest}"'
	);
});
