import { test, expect } from '@playwright/test';
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

test('lifecycle defaults enabled for backward compatibility', () => {
	expect(loadSyntheticConfig({})).toEqual({
		lifecycleEnabled: true,
		expectMaintenance: false
	});
});

test('maintenance expectation requires lifecycle checks disabled', () => {
	expect(() =>
		loadSyntheticConfig({
			SYNTHETIC_LIFECYCLE_ENABLED: 'true',
			SYNTHETIC_EXPECT_MAINTENANCE: 'true'
		})
	).toThrow('SYNTHETIC_EXPECT_MAINTENANCE=true requires SYNTHETIC_LIFECYCLE_ENABLED=false');
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
	).toBe(19);
	expect(
		expectedFullSuiteCheckCount({
			SYNTHETIC_LIFECYCLE_ENABLED: 'false',
			SYNTHETIC_EXPECT_MAINTENANCE: 'true',
			SYNTHETIC_ADMIN_USERNAME: 'admin',
			SYNTHETIC_ADMIN_PASSWORD: 'secret'
		})
	).toBe(19);
	expect(
		expectedFullSuiteCheckCount({
			SYNTHETIC_LIFECYCLE_ENABLED: 'false',
			SYNTHETIC_EXPECT_MAINTENANCE: 'false'
		})
	).toBe(14);
});
