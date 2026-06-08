// healthz.spec.ts — anonymous health endpoint, no auth required.
//
// This is the cheapest possible check; if /healthz is down the whole
// stack is down. Pairs with the API-layer healthz check from the Go
// synthetic monitor — having both ensures we can tell whether Caddy
// is the failure point (UI fails, API succeeds) or the API itself
// (both fail).

import { test, expect } from '@playwright/test';
import { loadCreds } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

test('healthz_returns_ok', async ({ request }, testInfo) => {
	meta(testInfo, {
		title: 'UI /healthz returns 200',
		description:
			'Anonymous GET /healthz through Caddy returns 200 with status ok/healthy/up. Cheapest possible end-to-end probe. If this fails alongside the API healthz, the whole stack is down. If only this fails, Caddy or DNS for crucible.jmal.io is the issue.',
		severity: 'critical',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-healthz-fails'
	});
	const { baseURL } = loadCreds();
	const res = await request.get(baseURL + '/healthz');
	expect(res.status(), 'healthz should be 200').toBe(200);
	const body = await res.json();
	expect(body.status ?? body.health ?? body).toMatch(/ok|healthy|up/i);
});
