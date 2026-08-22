const FILTER_FLAGS = new Set([
	'--debug',
	'--grep',
	'-g',
	'--grep-invert',
	'--last-failed',
	'--only-changed',
	'--project',
	'--repeat-each',
	'--shard',
	'--test-list',
	'--test-list-invert',
	'--ui',
	'--ui-host',
	'--ui-port'
]);
const VALUE_OPTIONS = new Set([
	'--config',
	'-c',
	'--global-timeout',
	'--max-failures',
	'--output',
	'--reporter',
	'--retries',
	'--timeout',
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

	if (
		argv.some(
			(argument) =>
				FILTER_FLAGS.has(argument) ||
				[...FILTER_FLAGS].some(
					(flag) => flag.startsWith('--') && argument.startsWith(`${flag}=`)
				)
		)
	) {
		return true;
	}

	const testCommand = argv.lastIndexOf('test');
	const testArguments = testCommand >= 0 ? argv.slice(testCommand + 1) : argv.slice(2);
	for (let index = 0; index < testArguments.length; index += 1) {
		const argument = testArguments[index];
		if (VALUE_OPTIONS.has(argument)) {
			index += 1;
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
