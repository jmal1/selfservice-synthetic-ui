// Shared Playwright fixtures.
//
// The Authentik OIDC dance is expensive (~3-5s + 2 redirects). To avoid
// doing it once per spec, we use Playwright's storage state mechanism:
// the auth.spec.ts runs first, performs the login, and saves the
// authenticated cookies + localStorage to disk; subsequent specs load
// that state and skip the login.
//
// Storage state file is regenerated on every full run so an expired
// session can't poison subsequent runs.

import { test as base, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

export { expect };

const STORAGE_FILE = path.resolve('.auth', 'synthetic-state.json');

export const test = base.extend<{ authedPage: Page }>({
	authedPage: async ({ browser }, use) => {
		if (!fs.existsSync(STORAGE_FILE)) {
			throw new Error(
				`No authenticated state at ${STORAGE_FILE}. Run the auth.spec.ts spec first ` +
					`(it runs as part of the default suite ordering).`
			);
		}
		const context = await browser.newContext({ storageState: STORAGE_FILE });
		const page = await context.newPage();
		await use(page);
		await context.close();
	}
});

export function storageStatePath(): string {
	return STORAGE_FILE;
}

export function ensureStorageDir(): void {
	const dir = path.dirname(STORAGE_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export interface Creds {
	username: string;
	password: string;
	baseURL: string;
}

export function loadCreds(): Creds {
	const username = process.env.SYNTHETIC_USERNAME;
	const password = process.env.SYNTHETIC_PASSWORD;
	const baseURL = process.env.SYNTHETIC_BASE_URL ?? 'https://crucible.jmal.io';
	if (!username || !password) {
		throw new Error(
			'SYNTHETIC_USERNAME and SYNTHETIC_PASSWORD must be set ' +
				'(see README — usually loaded from /opt/synthetic-ui/secrets/env)'
		);
	}
	return { username, password, baseURL };
}
