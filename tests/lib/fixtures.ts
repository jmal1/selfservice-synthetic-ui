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
	authedPage: async ({ browser, baseURL }, use) => {
		if (!fs.existsSync(STORAGE_FILE)) {
			throw new Error(
				`No authenticated state at ${STORAGE_FILE}. Run the auth.spec.ts spec first ` +
					`(it runs as part of the default suite ordering).`
			);
		}
		const context = await browser.newContext({
			storageState: STORAGE_FILE,
			baseURL
		});
		const page = await context.newPage();
		await use(page);
		await context.close();
	}
});

export function storageStatePath(): string {
	return STORAGE_FILE;
}

// ── Admin / instructor fixture ─────────────────────────────────────────────
//
// Some admin-facing pages (/admin/images, /admin/templates/new, /admin/runs)
// require the instructor or admin role. The student synthetic account is
// explicitly blocked from these routes (tested by admin-routes-403.spec.ts),
// so a separate authenticated session is needed to verify they actually work.
//
// Usage:
//   import { adminTest, expect } from '../lib/fixtures.ts';
//   const ADMIN_USERNAME = process.env.SYNTHETIC_ADMIN_USERNAME;
//   adminTest.skip(!ADMIN_USERNAME, 'SYNTHETIC_ADMIN_USERNAME not configured');
//   adminTest('my_check', async ({ authedAdminPage: page }, testInfo) => { ... });
//
// The storage state is created by 01-auth-admin.spec.ts; set
// SYNTHETIC_ADMIN_USERNAME and SYNTHETIC_ADMIN_PASSWORD in the secrets env
// file alongside the student credentials.

const ADMIN_STORAGE_FILE = path.resolve('.auth', 'synthetic-admin-state.json');

export const adminTest = base.extend<{ authedAdminPage: Page }>({
	authedAdminPage: async ({ browser, baseURL }, use) => {
		if (!fs.existsSync(ADMIN_STORAGE_FILE)) {
			throw new Error(
				`No admin/instructor auth state at ${ADMIN_STORAGE_FILE}. ` +
					`Set SYNTHETIC_ADMIN_USERNAME + SYNTHETIC_ADMIN_PASSWORD and run 01-auth-admin.spec.ts first.`
			);
		}
		const context = await browser.newContext({
			storageState: ADMIN_STORAGE_FILE,
			baseURL
		});
		const page = await context.newPage();
		await use(page);
		await context.close();
	}
});

export function adminStorageStatePath(): string {
	return ADMIN_STORAGE_FILE;
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
	const baseURL = process.env.SYNTHETIC_BASE_URL ?? 'https://crucible.example.test';
	if (!username || !password) {
		throw new Error(
			'SYNTHETIC_USERNAME and SYNTHETIC_PASSWORD must be set ' +
				'(see README — usually loaded from the operator secrets env file)'
		);
	}
	return { username, password, baseURL };
}
