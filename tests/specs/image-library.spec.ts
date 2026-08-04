// image-library.spec.ts — instructor-authenticated check that the VM image
// library page renders end-to-end.
//
// The student-role admission gate for this route is covered separately by
// admin-routes-403.spec.ts (admin_route_protected_admin_images). This spec
// covers the complementary case: the page actually WORKS for an authorized
// instructor. Both checks must be green for the feature to be healthy.
//
// What this checks:
//   1. "VM Images" heading renders (page loaded, not error boundary or redirect)
//   2. "Browse files" upload control is present (drop-zone section rendered)
//   3. "Staged images" section heading is present (list container rendered)
//
// What breaks it:
//   - The onMount auth check in +page.svelte fails and redirects to /admin
//   - A SvelteKit error boundary crashes before rendering
//   - The drop-zone section or Staged images card is removed from the page

import { adminTest, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const ADMIN_USERNAME = process.env.SYNTHETIC_ADMIN_USERNAME;
adminTest.skip(
	!ADMIN_USERNAME,
	'SYNTHETIC_ADMIN_USERNAME not configured; skipping instructor-role synthetic specs'
);

adminTest('image_library_loads', async ({ authedAdminPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Image library page loads for instructor',
		description:
			'Instructor navigates to /admin/images and the VM image library renders: "VM Images" page ' +
			'heading, "Browse files" drop-zone upload control, and "Staged images" section heading are ' +
			'all visible. Proves the whole Caddy -> Authentik -> SvelteKit path reaches the Epic A ' +
			'admin page for an authorized user. A failure indicates a broken admin page, missing ' +
			'upload UI, or instructor-role regression.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#when-image_library_loads-fails'
	});

	await page.goto('/admin/images');

	// The page's onMount checks authStore.isInstructor || authStore.isAdmin and
	// redirects to /admin if the check fails. "VM Images" only renders if the
	// instructor session reached the page and the component mounted successfully.
	await expect(
		page.getByRole('heading', { name: 'VM Images' }),
		'"VM Images" heading must be visible — if missing, the page either redirected away ' +
			'(instructor role regression) or an error boundary rendered instead'
	).toBeVisible({ timeout: 15_000 });

	// The drop-zone section (<section aria-label="File drop zone">) contains the
	// "Browse files" label-button. A <label> element is not a <button> role, so we
	// locate it by text. Its absence means the upload UI was removed from the page.
	await expect(
		page.getByText('Browse files'),
		'"Browse files" upload control must be visible — its absence means the drop-zone ' +
			'section was removed or the label text changed'
	).toBeVisible({ timeout: 10_000 });

	// The "Staged images" card section (<h2>Staged images</h2>) is rendered
	// unconditionally — it shows either a table, a loading message, or a "No images
	// yet" placeholder, but the heading is always in the DOM. Its absence means the
	// entire card section was removed.
	await expect(
		page.getByRole('heading', { name: 'Staged images' }),
		'"Staged images" section heading must be present — its absence indicates the image ' +
			'list card section was removed from the page'
	).toBeVisible({ timeout: 10_000 });

	// The "Status" column header in the Staged images table is added as part of the
	// lifecycle-state display feature (lane 3). Its presence proves that the table
	// still includes the status column, so operators can see uploading / importing /
	// imported / error state for each image.
	await expect(
		page.getByRole('columnheader', { name: 'Status' }),
		'"Status" column header must be visible in the Staged images table — its absence means ' +
			'the lifecycle-state column was removed, breaking the operator visibility feature'
	).toBeVisible({ timeout: 10_000 });
});
