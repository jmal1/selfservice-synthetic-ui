const FILTER_FLAGS = new Set([
	'--grep',
	'-g',
	'--grep-invert',
	'--last-failed',
	'--only-changed',
	'--project',
	'--shard',
	'--test-list',
	'--test-list-invert',
	'--ui'
]);
const VALUE_OPTIONS = new Set([
	'--config',
	'-c',
	'--global-timeout',
	'--max-failures',
	'-x',
	'--output',
	'--repeat-each',
	'--reporter',
	'--retries',
	'--timeout',
	'--tsconfig',
	'--workers',
	'-j'
]);

export function hasIntentionalTestSelection(argv: readonly string[]): boolean {
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
