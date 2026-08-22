// Audited against `playwright test --help` in Playwright 1.60. These modes
// select, repeat, reconfigure, or interactively control execution, so they
// must never replace the production Pushgateway group.
const NON_PUBLISHING_LONG_OPTIONS = [
	'--browser',
	'--config',
	'--debug',
	'--grep',
	'--grep-invert',
	'--last-failed',
	'--only-changed',
	'--project',
	'--repeat-each',
	'--run-agents',
	'--shard',
	'--test-list',
	'--test-list-invert',
	'--ui',
	'--ui-host',
	'--ui-port',
	'--update-snapshots',
	'--update-source-method'
] as const;
const NON_PUBLISHING_SHORT_OPTIONS = ['-c', '-g', '-u'] as const;

// Value-taking options that are valid for a full production run. Split values
// must be consumed so they are not mistaken for positional test filters.
const FULL_RUN_VALUE_OPTIONS = new Set([
	'--global-timeout',
	'--max-failures',
	'--output',
	'--reporter',
	'--retries',
	'--timeout',
	'--trace',
	'--tsconfig',
	'--workers',
	'-j'
]);

export interface ReporterEnvironment {
	PWDEBUG?: string;
}

export function hasIntentionalTestSelection(
	argv: readonly string[],
	env: ReporterEnvironment = {}
): boolean {
	if (env.PWDEBUG !== undefined && env.PWDEBUG !== '') return true;

	for (const argument of argv) {
		if (
			NON_PUBLISHING_LONG_OPTIONS.some(
				(option) => argument === option || argument.startsWith(`${option}=`)
			) ||
			NON_PUBLISHING_SHORT_OPTIONS.some(
				(option) => argument === option || argument.startsWith(option)
			)
		) {
			return true;
		}
	}

	const testCommand = argv.lastIndexOf('test');
	const testArguments = testCommand >= 0 ? argv.slice(testCommand + 1) : argv.slice(2);
	for (let index = 0; index < testArguments.length; index += 1) {
		const argument = testArguments[index];
		if (FULL_RUN_VALUE_OPTIONS.has(argument)) {
			index += 1;
			continue;
		}
		if (
			argument.startsWith('-j') &&
			argument !== '-j'
		) {
			continue;
		}
		if (!argument.startsWith('-')) return true;
	}
	return false;
}

export function isListOnlyRun(argv: readonly string[]): boolean {
	return argv.includes('--list');
}

export interface ReplacementPolicy {
	intentionallyFiltered: boolean;
	listOnly: boolean;
}

export function shouldPublishReplacement(policy: ReplacementPolicy): boolean {
	return !policy.listOnly && !policy.intentionallyFiltered;
}

export function mustForceOverallFailure(
	fullResultStatus: string,
	discoveredCheckCount: number,
	expectedFullSuiteCheckCount: number
): boolean {
	return (
		fullResultStatus !== 'passed' ||
		discoveredCheckCount !== expectedFullSuiteCheckCount
	);
}
