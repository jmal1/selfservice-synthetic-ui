import { writeFileSync } from 'node:fs';

const [outputPath] = process.argv.slice(2);
const digest = process.env.IMAGE_DIGEST;
const sourceSha = process.env.SOURCE_SHA;

if (!outputPath) {
	throw new Error('output path is required');
}
if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) {
	throw new Error('IMAGE_DIGEST must be a sha256 digest');
}
if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) {
	throw new Error('SOURCE_SHA must be a full 40-character Git SHA');
}

const fields = [
	'synthetic-ui',
	'ghcr.io/jmal1/selfservice-synthetic-ui',
	digest,
	sourceSha
];
writeFileSync(outputPath, `${fields.join('\t')}\n`, 'utf8');
