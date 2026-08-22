export interface SyntheticConfig {
	lifecycleEnabled: boolean;
	expectMaintenance: boolean;
}

export function parseBooleanEnv(
	name: string,
	value: string | undefined,
	defaultValue: boolean
): boolean {
	if (value === undefined) return defaultValue;

	if (value === 'true') return true;
	if (value === 'false') return false;

	throw new Error(`${name} must be exactly "true" or "false"; received ${JSON.stringify(value)}`);
}

export function loadSyntheticConfig(
	env: NodeJS.ProcessEnv = process.env
): SyntheticConfig {
	const lifecycleEnabled = parseBooleanEnv(
		'SYNTHETIC_LIFECYCLE_ENABLED',
		env.SYNTHETIC_LIFECYCLE_ENABLED,
		true
	);
	const expectMaintenance = parseBooleanEnv(
		'SYNTHETIC_EXPECT_MAINTENANCE',
		env.SYNTHETIC_EXPECT_MAINTENANCE,
		false
	);

	if (lifecycleEnabled && expectMaintenance) {
		throw new Error(
			'SYNTHETIC_EXPECT_MAINTENANCE=true requires SYNTHETIC_LIFECYCLE_ENABLED=false; ' +
				'refusing to register destructive checks while maintenance is expected'
		);
	}

	return { lifecycleEnabled, expectMaintenance };
}

export function expectedFullSuiteCheckCount(
	env: NodeJS.ProcessEnv = process.env,
	config = loadSyntheticConfig(env)
): number {
	// Fourteen checks are unconditional. The admin login and its three
	// dependent checks, lifecycle check, and maintenance check are conditional.
	let count = 14;
	if (env.SYNTHETIC_ADMIN_USERNAME) count += 3;
	if (env.SYNTHETIC_ADMIN_USERNAME && env.SYNTHETIC_ADMIN_PASSWORD) count += 1;
	if (config.lifecycleEnabled && env.SYNTHETIC_TEMPLATE_NAME) count += 1;
	if (config.expectMaintenance) count += 1;
	return count;
}

export const syntheticConfig = loadSyntheticConfig();
