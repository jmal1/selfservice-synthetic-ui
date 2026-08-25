import { type Page, type Route } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const CHECKING_PROVISIONING = 'Checking provisioning availability…';
const MAINTENANCE_MESSAGE =
	'Provisioning is temporarily unavailable for maintenance.';
const STATUS_UNAVAILABLE =
	"We can't confirm whether provisioning is available right now, so new deployments are paused.";

type ProvisioningResponse =
	| { enabled: boolean; message: string }
	| { unavailable: true };

async function installWmksTransportStub(page: Page): Promise<void> {
	await page.route('**/wmks/wmks.js', async (route) => {
		await route.fulfill({
			contentType: 'application/javascript',
			body: `
				(() => {
					const events = {
						CONNECTION_STATE_CHANGE: 'connection-state-change',
						ERROR: 'error'
					};
					const connectionState = {
						CONNECTED: 'connected',
						DISCONNECTED: 'disconnected'
					};

					window.WMKS = {
						CONST: {
							Events: events,
							ConnectionState: connectionState,
							Position: { CENTER: 'center' }
						},
						createWMKS(containerId) {
							const callbacks = new Map();
							const container = document.getElementById(containerId);
							const canvas = document.createElement('canvas');
							canvas.id = 'mainCanvas';
							canvas.width = 800;
							canvas.height = 600;
							container.appendChild(canvas);

							return {
								register(event, callback) {
									callbacks.set(event, callback);
								},
								connect() {
									queueMicrotask(() => {
										callbacks.get(events.CONNECTION_STATE_CHANGE)?.(null, {
											state: connectionState.CONNECTED
										});
									});
								},
								updateScreen() {},
								sendCAD() {},
								disconnect() {},
								destroy() {}
							};
						}
					};
				})();
			`
		});
	});
}

async function expectStableRefresh(
	page: Page,
	trigger: () => Promise<void>
): Promise<void> {
	const contentHeading = page
		.locator('#main-content h1, #main-content h2')
		.filter({ hasText: /dashboard|labs|environments|pods/i })
		.first();
	const before = await contentHeading.boundingBox();
	expect(before, 'dashboard content heading must have a measurable position').not.toBeNull();

	const requestStarted = page.waitForRequest((request) =>
		request.url().endsWith('/api/v1/provisioning/status')
	);
	const responseFinished = page.waitForResponse((response) =>
		response.url().endsWith('/api/v1/provisioning/status')
	);
	await trigger();
	await requestStarted;
	await page.waitForTimeout(100);

	const during = await contentHeading.boundingBox();
	expect(during, 'dashboard content heading must remain mounted during refresh').not.toBeNull();
	expect(
		Math.abs(during!.y - before!.y),
		'known-enabled refresh must not shift dashboard content'
	).toBeLessThan(1);

	await responseFinished;
}

async function expireProvisioningStatusCache(page: Page): Promise<void> {
	await page.evaluate(() => {
		const state = window as typeof window & {
			provisioningClockOffset?: number;
			provisioningRealNow?: () => number;
		};
		state.provisioningRealNow ??= Date.now.bind(Date);
		state.provisioningClockOffset = (state.provisioningClockOffset ?? 0) + 61_000;
		Date.now = () =>
			state.provisioningRealNow!() + (state.provisioningClockOffset ?? 0);
	});
}

test('console_canvas_keeps_physical_keyboard_delivery', async (
	{ authedPage: page },
	testInfo
) => {
	meta(testInfo, {
		title: 'Connected console canvas keeps browser keyboard focus',
		description:
			'Loads the real console UI with only the WMKS transport stubbed as connected, then proves the SDK-created canvas is focusable and receives physical Playwright keyboard events before and after using the Text Input toolbar. Paste and Text Input remain available. This intentionally stops at browser event delivery; the guest framebuffer requires the supervised live gate.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#runbook'
	});
	testInfo.annotations.push({
		type: 'console-coverage-limit',
		description:
			'Automated coverage proves browser focus and keydown delivery to the WMKS canvas, not guest-visible characters. The supervised live gate must confirm physical typing appears in a connected guest framebuffer.'
	});

	await installWmksTransportStub(page);
	await page.route('**/api/v1/pods/synthetic-focus-pod', async (route) => {
		await route.fulfill({
			json: {
				id: 'synthetic-focus-pod',
				status: 'active',
				vms: [
					{
						id: 'synthetic-focus-vm',
						display_name: 'Synthetic focus VM',
						vcenter_vm_name: 'synthetic-focus-vm',
						status: 'running'
					}
				]
			}
		});
	});

	await page.goto('/console/synthetic-focus-pod/synthetic-focus-vm');
	await expect(page.getByText('Connected', { exact: true })).toBeVisible();

	const canvasContainer = page.locator('#console-canvas');
	const canvas = canvasContainer.locator('canvas');
	const pasteButton = page.getByTitle('Paste clipboard into VM (Ctrl+Shift+V)');
	const textInputButton = page.getByTitle('Open text input panel for pasting into VM');
	await expect(canvas).toBeVisible();
	await expect(pasteButton).toBeEnabled();
	await expect(textInputButton).toBeVisible();
	await expect(
		canvas,
		'connected WMKS canvas must be made programmatically focusable'
	).toHaveAttribute('tabindex', '0');

	await canvas.evaluate((element) => {
		(element as HTMLCanvasElement & { receivedKeys?: string[] }).receivedKeys = [];
		element.addEventListener('keydown', (event) => {
			(element as HTMLCanvasElement & { receivedKeys?: string[] }).receivedKeys?.push(
				(event as KeyboardEvent).code
			);
		});
	});

	await canvasContainer.click({ position: { x: 20, y: 20 } });
	await expect(
		canvas,
		'clicking the console surface must focus the SDK-created canvas'
	).toBeFocused();
	await page.keyboard.press('KeyA');
	await expect
		.poll(() =>
			canvas.evaluate(
				(element) =>
					(element as HTMLCanvasElement & { receivedKeys?: string[] }).receivedKeys
			)
		)
		.toContain('KeyA');

	await textInputButton.click();
	await expect(
		page.getByPlaceholder(/Type or paste text here/),
		'Text Input toolbar must remain usable'
	).toBeVisible();
	await expect(pasteButton, 'Paste toolbar must remain available while connected').toBeEnabled();

	await canvasContainer.click({ position: { x: 20, y: 20 } });
	await expect(
		canvas,
		'console must reacquire focus after toolbar interaction'
	).toBeFocused();
	await page.keyboard.press('KeyB');
	await expect
		.poll(() =>
			canvas.evaluate(
				(element) =>
					(element as HTMLCanvasElement & { receivedKeys?: string[] }).receivedKeys
			)
		)
		.toContain('KeyB');
});

test('known_enabled_provisioning_refresh_never_mounts_loading_banner', async (
	{ authedPage: page },
	testInfo
) => {
	meta(testInfo, {
		title: 'Known-enabled provisioning refresh stays visually stable',
		description:
			'Forces deterministic enabled provisioning responses, observes every DOM mutation during delayed focus and visibility refreshes, and proves the yellow checking banner never mounts or shifts dashboard content once enabled is known. It then verifies disabled and unavailable warnings still render.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#runbook'
	});

	let response: ProvisioningResponse = {
		enabled: true,
		message: 'Provisioning is available.'
	};
	let requestCount = 0;
	await page.route('**/api/v1/provisioning/status', async (route: Route) => {
		requestCount += 1;
		if (requestCount > 1) await new Promise((resolve) => setTimeout(resolve, 350));

		if ('unavailable' in response) {
			await route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'status unavailable' })
			});
			return;
		}
		await route.fulfill({ json: response });
	});

	const initialStatus = page.waitForResponse((candidate) =>
		candidate.url().endsWith('/api/v1/provisioning/status')
	);
	await page.goto('/');
	await initialStatus;
	await expect(
		page.getByRole('link', { name: 'Deploy VM', exact: true }).first()
	).toBeVisible();
	await expect(page.getByText(CHECKING_PROVISIONING, { exact: true })).toHaveCount(0);

	await page.evaluate((checkingText) => {
		const state = window as typeof window & {
			provisioningLoadingMounts?: string[];
			provisioningObserver?: MutationObserver;
		};
		state.provisioningLoadingMounts = [];
		const recordLoadingBanner = (records: MutationRecord[] = []) => {
			if (document.body.textContent?.includes(checkingText)) {
				state.provisioningLoadingMounts?.push(checkingText);
			}
			for (const record of records) {
				const texts =
					record.type === 'characterData'
						? [record.oldValue, record.target.textContent]
						: [...record.addedNodes].map((node) => node.textContent);
				if (texts.some((text) => text?.includes(checkingText))) {
					state.provisioningLoadingMounts?.push(checkingText);
				}
			}
		};
		state.provisioningObserver = new MutationObserver(recordLoadingBanner);
		state.provisioningObserver.observe(document.body, {
			childList: true,
			characterData: true,
			characterDataOldValue: true,
			subtree: true
		});
		recordLoadingBanner();
	}, CHECKING_PROVISIONING);

	await expireProvisioningStatusCache(page);
	await expectStableRefresh(page, async () => {
		await page.evaluate(() => {
			window.dispatchEvent(new Event('blur'));
			window.dispatchEvent(new Event('focus'));
		});
	});

	await expireProvisioningStatusCache(page);
	await expectStableRefresh(page, async () => {
		await page.evaluate(() => {
			let visibility: DocumentVisibilityState = 'hidden';
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => visibility
			});
			document.dispatchEvent(new Event('visibilitychange'));
			visibility = 'visible';
			document.dispatchEvent(new Event('visibilitychange'));
		});
	});

	expect(requestCount, 'initial load, focus, and visibility restore must each check status').toBe(3);
	expect(
		await page.evaluate(
			() =>
				(window as typeof window & { provisioningLoadingMounts?: string[] })
					.provisioningLoadingMounts
		),
		'MutationObserver must see no transient loading-banner mount after enabled is known'
	).toEqual([]);
	await expect(page.getByText(CHECKING_PROVISIONING, { exact: true })).toHaveCount(0);

	response = { enabled: false, message: MAINTENANCE_MESSAGE };
	await expireProvisioningStatusCache(page);
	const disabledResponse = page.waitForResponse((candidate) =>
		candidate.url().endsWith('/api/v1/provisioning/status')
	);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await disabledResponse;
	const warning = page.locator(
		'aside[role="alert"][aria-labelledby="provisioning-maintenance-title"]'
	);
	await expect(warning).toBeVisible();
	await expect(warning.getByText(MAINTENANCE_MESSAGE, { exact: true })).toBeVisible();

	response = { unavailable: true };
	await expireProvisioningStatusCache(page);
	const unavailableResponse = page.waitForResponse((candidate) =>
		candidate.url().endsWith('/api/v1/provisioning/status')
	);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await unavailableResponse;
	await expect(warning).toBeVisible();
	await expect(warning.getByText(STATUS_UNAVAILABLE, { exact: true })).toBeVisible();
});
