// healthz.spec.ts — anonymous health endpoint, no auth required.
//
// This is the cheapest possible check; if /healthz is down the whole
// stack is down. Pairs with the API-layer healthz check from the Go
// synthetic monitor — having both ensures we can tell whether Caddy
// is the failure point (UI fails, API succeeds) or the API itself
// (both fail).

import { test, expect } from '@playwright/test';
import { loadCreds } from '../lib/fixtures.ts';

test('healthz_returns_ok', async ({ request }) => {
	const { baseURL } = loadCreds();
	const res = await request.get(baseURL + '/healthz');
	expect(res.status(), 'healthz should be 200').toBe(200);
	const body = await res.json();
	expect(body.status ?? body.health ?? body).toMatch(/ok|healthy|up/i);
});
