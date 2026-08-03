// minio-cors.spec.ts — browser-level probe of the MinIO upload endpoint.
//
// The image-upload feature has the browser PUT directly to
// https://s3.lab.jmal.io using a presigned URL. That path has failure
// modes which are *structurally invisible* to any API-layer synthetic,
// because they are enforced by the browser and not by the server:
//
//   * mixed content   — the UI is HTTPS; a plain-HTTP S3 endpoint is
//                       silently blocked before a request is ever sent
//   * TLS validity    — an expired/untrusted cert makes fetch() reject.
//                       This is a live regression class here: the Azure
//                       DNS service-principal secret behind cert-manager's
//                       DNS-01 solver expired once and went unnoticed for
//                       17 days, because a "Ready" ClusterIssuer reflects
//                       only the ACME account, never the DNS credential
//   * CORS            — without an allow-origin for the Crucible origin,
//                       every upload fails in the browser while curl from
//                       a shell keeps working perfectly
//
// This runs an unauthenticated, unsigned PUT from the real page origin.
// It is *expected* to be rejected by MinIO (403/400) — the assertion is
// that the browser was allowed to send it at all, i.e. that preflight
// succeeded. An unsigned PUT cannot write an object, so this probe
// leaves nothing behind.
//
// Requires no admin privileges, so it works with the student-role
// synthetic user.

import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const S3_ORIGIN = process.env.SYNTHETIC_S3_ORIGIN ?? 'https://s3.lab.jmal.io';

test('minio_upload_endpoint_reachable', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'MinIO Upload Endpoint Reachable From Browser',
		description:
			'From the real Crucible page origin, fetches the MinIO health endpoint and issues an ' +
			'unsigned cross-origin PUT to s3.lab.jmal.io. Proves the browser can reach MinIO over a ' +
			'trusted TLS certificate with no mixed-content block, and that CORS preflight allows PUT ' +
			'from the Crucible origin. These are browser-only failure modes that API-layer checks ' +
			'cannot detect. A failure most often means the s3-tls certificate failed to renew (check ' +
			'cert-manager and the Azure DNS credential), MinIO is down on stagingv01, or the ' +
			'MINIO_API_CORS_ALLOW_ORIGIN setting was lost on restart.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-minio_upload_endpoint_reachable-fails'
	});

	// Land on the real origin so the browser sends the true Origin header
	// and applies this page's mixed-content policy.
	await page.goto('/');

	// 1. Health endpoint over HTTPS. A TLS failure, DNS failure, or
	//    mixed-content block all surface here as a rejected fetch.
	const health = await page.evaluate(async (origin) => {
		try {
			const res = await fetch(`${origin}/minio/health/live`, { method: 'GET', mode: 'cors' });
			return { sent: true, status: res.status };
		} catch (err) {
			return { sent: false, error: String(err) };
		}
	}, S3_ORIGIN);

	expect(
		health.sent,
		`browser could not reach ${S3_ORIGIN}/minio/health/live (${health.error ?? ''}). ` +
			'Expired TLS cert, DNS failure, or a mixed-content block.'
	).toBe(true);
	expect(health.status, 'MinIO health endpoint must return 200').toBe(200);

	// 2. Unsigned cross-origin PUT. PUT is not a CORS-simple method, so the
	//    browser must first run an OPTIONS preflight; if MinIO does not
	//    allow this origin the fetch rejects and `sent` is false.
	//    A 4xx here is the success case: the request left the browser and
	//    MinIO rejected it for missing credentials, which writes nothing.
	const put = await page.evaluate(async (origin) => {
		try {
			const res = await fetch(`${origin}/isos/crucible/.synthetic-cors-probe`, {
				method: 'PUT',
				mode: 'cors',
				body: 'probe'
			});
			return { sent: true, status: res.status };
		} catch (err) {
			return { sent: false, error: String(err) };
		}
	}, S3_ORIGIN);

	expect(
		put.sent,
		`CORS preflight for a cross-origin PUT to ${S3_ORIGIN} was blocked (${put.error ?? ''}). ` +
			'Browser uploads cannot work in this state even though curl from a shell will succeed. ' +
			'Check MINIO_API_CORS_ALLOW_ORIGIN in /etc/default/minio on stagingv01.'
	).toBe(true);

	// The unsigned PUT must be refused. A 2xx would mean the bucket accepts
	// anonymous writes from any browser — a far more serious problem than
	// the outage this check was written to detect.
	expect(
		put.status,
		`unsigned PUT returned ${put.status}; MinIO must reject unauthenticated writes`
	).toBeGreaterThanOrEqual(400);
});
