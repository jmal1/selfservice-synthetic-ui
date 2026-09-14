// assessment-target-vm.spec.ts — asserts the student Assessments page shows
// which VM a playlist will grade, and that run detail repeats Target VM on
// each workflow/check row (Crucible #47).
//
// Contract under test (selfservice-api + selfservice-ui):
//   GET /api/v1/pods/{id}/testing returns targets[] (not a flat playlists list)
//   each target carries pod_vm_id + display_name (+ optional ip)
//   UI groups offers by VM and labels "Runs against …"
//   completed runs with target_vm_name show that name on workflow headers

import { expect, test } from '../lib/fixtures.ts';
import { parsePodSummaries } from '../lib/maintenance.ts';
import { meta } from '../lib/synthetic.ts';

interface TestingPlaylist {
	id: string;
	name: string;
}

interface TestingTarget {
	pod_vm_id: string;
	display_name: string;
	ip_address?: string;
	status?: string;
	playlists?: TestingPlaylist[];
}

interface TestingDashboard {
	targets?: TestingTarget[] | null;
	playlists?: unknown;
	recent_runs?: Array<{
		id: string;
		status?: string;
		target_vm_name?: string;
		target_vm_ip?: string;
	}> | null;
}

test('assessment_target_vm_shown', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Assessment selector shows target VM',
		description:
			'Finds a student-owned pod whose testing dashboard returns at least one target with a playlist, ' +
			'asserts GET /testing exposes targets[] (not a flat playlists-only payload), opens the Assessments ' +
			'page and checks the VM name and "Runs against" label, then — when a recent run has target_vm_name — ' +
			'opens that run and asserts Target VM appears on a workflow/check row. Catches regressions where ' +
			'same-template twins collapse into anonymous assessment cards or run detail omits which VM was graded.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Crucible/blob/main/future/Synthetic-Monitoring.md#when-assessment_target_vm_shown-fails'
	});

	const podsResp = await page.request.get('/api/v1/pods', {
		headers: { accept: 'application/json' },
		failOnStatusCode: false,
		timeout: 15_000
	});
	expect(podsResp.status(), 'GET /api/v1/pods must return 200 for the student session').toBe(200);

	const studentPods = parsePodSummaries(await podsResp.json()).slice(0, 25);
	expect(
		studentPods.length,
		'Need at least one student-visible pod to exercise the assessment selector'
	).toBeGreaterThan(0);

	let selected:
		| {
				podId: string;
				target: TestingTarget;
				playlist: TestingPlaylist;
				dashboard: TestingDashboard;
		  }
		| undefined;

	for (const pod of studentPods) {
		const dashResp = await page.request.get(`/api/v1/pods/${pod.id}/testing`, {
			headers: { accept: 'application/json' },
			failOnStatusCode: false,
			timeout: 15_000
		});
		if (dashResp.status() === 404) continue;
		expect(
			dashResp.status(),
			`GET /api/v1/pods/${pod.id}/testing must return 200 for a student-owned pod`
		).toBe(200);

		const dashboard = (await dashResp.json()) as TestingDashboard;
		expect(
			Array.isArray(dashboard.targets),
			`GET /pods/${pod.id}/testing must return a targets array (per-VM offers). ` +
				`A flat playlists-only payload is the pre-#47 contract and is a regression.`
		).toBe(true);
		expect(
			dashboard.playlists,
			`GET /pods/${pod.id}/testing must not resurrect the flat playlists field; offers live under targets[].playlists`
		).toBeUndefined();

		for (const target of dashboard.targets ?? []) {
			if (!target?.pod_vm_id || !target.display_name?.trim()) continue;
			const playlist = (target.playlists ?? []).find((p) => p?.id && p?.name);
			if (!playlist) continue;
			selected = { podId: pod.id, target, playlist, dashboard };
			break;
		}
		if (selected) break;
	}

	expect(
		selected,
		'No student-owned pod returned a reachable testing target with at least one playlist. ' +
			'Seed template_playlists on a student-visible active pod (or restore the runner-results fixture) before this check can pass.'
	).toBeTruthy();

	const { podId, target, playlist, dashboard } = selected!;

	await page.goto(`/pods/${podId}/testing`);
	await expect(page).toHaveURL(new RegExp(`^.*\\/pods\\/${podId}\\/testing/?$`), {
		timeout: 15_000
	});
	await expect(page.getByRole('heading', { name: 'Assessments', exact: true })).toBeVisible({
		timeout: 15_000
	});
	await expect(page.getByRole('heading', { name: 'Available Assessments', exact: true })).toBeVisible({
		timeout: 15_000
	});

	const vmHeading = page.getByRole('heading', { name: target.display_name, exact: true }).first();
	await expect(
		vmHeading,
		`Assessments page must show VM heading "${target.display_name}" so same-template twins are distinguishable`
	).toBeVisible({ timeout: 15_000 });

	const playlistCard = page
		.locator('.card')
		.filter({ has: page.getByRole('heading', { name: playlist.name, exact: true }) })
		.filter({ hasText: `Runs against ${target.display_name}` })
		.first();
	await expect(
		playlistCard,
		`Playlist "${playlist.name}" must be labeled "Runs against ${target.display_name}"`
	).toBeVisible({ timeout: 15_000 });
	await expect(
		playlistCard.getByRole('button', { name: /Run All/i }),
		'Each assessment offer must expose a Run All control tied to that VM'
	).toBeVisible();

	await expect(
		page.getByRole('columnheader', { name: 'Assessed VM' }),
		'Recent Runs table must include an Assessed VM column'
	).toBeVisible({ timeout: 15_000 });

	const recentRuns = dashboard.recent_runs ?? [];
	const attributed = recentRuns.find(
		(r) => r?.id && typeof r.target_vm_name === 'string' && r.target_vm_name.trim() !== ''
	);
	if (!attributed) {
		// Selector contract is already proved above. Attribution on workflow rows
		// needs a retained run with target_vm_name; fixture pods may predate that
		// column being populated. Fail loudly only when a terminal run exists but
		// lacks the name — that is the silent-attribution regression.
		const anyTerminal = recentRuns.find((r) => r?.id);
		expect(
			anyTerminal,
			'No recent runs on this pod yet; selector assertions already passed. ' +
				'If a completed run exists without target_vm_name, restore attribution before merging.'
		).toBeUndefined();
		return;
	}

	await page.goto(`/pods/${podId}/testing/runs/${attributed.id}`);
	await expect(page).toHaveURL(
		new RegExp(`^.*\\/pods\\/${podId}\\/testing\\/runs\\/${attributed.id}/?$`),
		{ timeout: 15_000 }
	);
	await expect(page.getByRole('heading', { name: 'Run Details' })).toBeVisible({
		timeout: 15_000
	});

	const headerTarget = page
		.locator('p')
		.filter({ hasText: 'Target VM' })
		.locator('..')
		.getByText(attributed.target_vm_name!, { exact: false })
		.first();
	await expect(
		headerTarget,
		`Run header must show Target VM "${attributed.target_vm_name}"`
	).toBeVisible({ timeout: 15_000 });

	const workflowPicker = page.locator('button[aria-expanded]').first();
	await expect(
		workflowPicker,
		'Run detail must list at least one workflow/check row'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		workflowPicker.getByText(`Target VM: ${attributed.target_vm_name}`, { exact: false }),
		`Each workflow/check row must repeat Target VM "${attributed.target_vm_name}" so scanning results answers which machine was graded`
	).toBeVisible({ timeout: 15_000 });
});
