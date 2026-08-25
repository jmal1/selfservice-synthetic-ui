import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function bashPath(value: string): string {
	return JSON.stringify(value.replace(/\\/g, '/'));
}

export function materializeSandboxedWrapper(
	root: string,
	reportRoot: string,
	resultsRoot: string
): string {
	const source = readFileSync(join(process.cwd(), 'scripts', 'run-synthetic-ui.sh'), 'utf8');
	const script = source
		.replace(
			'readonly report_root="/opt/synthetic-ui/report"',
			`readonly report_root=${bashPath(reportRoot)}`
		)
		.replace(
			'readonly results_root="/opt/synthetic-ui/results"',
			`readonly results_root=${bashPath(resultsRoot)}`
		);
	if (
		script === source ||
		!script.includes(`readonly report_root=${bashPath(reportRoot)}`) ||
		!script.includes(`readonly results_root=${bashPath(resultsRoot)}`)
	) {
		throw new Error('wrapper production bind-source constants were not replaced');
	}

	const scriptsDir = join(root, 'scripts');
	const wrapper = join(scriptsDir, 'run-synthetic-ui.sh');
	mkdirSync(scriptsDir, { recursive: true });
	writeFileSync(wrapper, script);
	chmodSync(wrapper, 0o755);
	return wrapper.replace(/\\/g, '/');
}
