// Gate B2: unique nonce typed with physical keyboard events must reach the
// live CoreWMKS KeyboardManager2 path. Sibling of
// console_canvas_keeps_physical_keyboard_delivery, which remains supporting
// evidence only (canvas / DOM focus is not acceptance).
//
// Depends on the UI's #console-canvas synth path (selfservice-ui WMKSConsole:
// page capture → preventDefault → dispatchEvent on #console-canvas so the
// SDK keydown.wmks bind runs). The stub mirrors that bind. GuestOps readback
// is documented, not implemented here.

import { type Page, type TestInfo } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';
import {
	assertGuestNonceProof,
	attachCanvasKeySpy,
	createPhysicalNonce,
	GUEST_OPS_CONTRACT,
	installKeyboardManager2Stub,
	nonceFileForGuest,
	physicalKeyForChar,
	probeGuestOps,
	readCanvasKeyCodes,
	readKeyboardManagerEvidence,
	typePhysicalNonce,
	UBUNTU_KEYBOARD_FIXTURE,
	WINDOWS_KEYBOARD_FIXTURE,
	type ConsoleKeyboardFixture
} from '../lib/console-keyboard.ts';

const RUNBOOK =
	'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#runbook';

async function runPhysicalNonceGate(
	page: Page,
	testInfo: TestInfo,
	fixture: ConsoleKeyboardFixture
): Promise<void> {
	const nonce = createPhysicalNonce();
	await installKeyboardManager2Stub(page, fixture);
	await page.goto(`/console/${fixture.podId}/${fixture.vmId}`);
	await expect(page.getByText('Connected', { exact: true })).toBeVisible();

	const canvasContainer = page.locator('#console-canvas');
	const pasteButton = page.getByTitle('Paste clipboard into VM (Ctrl+V)');
	const textInputButton = page.getByTitle('Open text input panel for pasting into VM');
	await expect(canvasContainer.locator('canvas')).toBeVisible();
	await expect(pasteButton).toBeEnabled();
	await expect(textInputButton).toBeVisible();
	await expect(canvasContainer).toHaveAttribute('tabindex', '0');
	await expect(canvasContainer).toBeFocused();

	await attachCanvasKeySpy(page);
	await typePhysicalNonce(page, nonce);

	const canvasKeyCodes = await readCanvasKeyCodes(page);
	const manager = await readKeyboardManagerEvidence(page);
	const pasteOrTextInputUsed =
		manager.pasteCalls.some((text) => text.includes(nonce)) ||
		(await textInputButton.getAttribute('aria-expanded')) === 'true';

	assertGuestNonceProof({
		nonce,
		canvasKeyCodes,
		keyboardManagerKeyCodes: manager.codes,
		keyboardManagerChars: manager.chars,
		pasteOrTextInputUsed,
		guestFileContents: null
	});
	const expectedCodes = [...nonce].map(physicalKeyForChar);
	expect(
		manager.chars.includes(nonce) ||
			expectedCodes.every((code) => manager.codes.includes(code)),
		'sabotage guard: KeyboardManager2 must observe the nonce; canvas-only delivery must fail this check'
	).toBe(true);

	const guestOps = await probeGuestOps(page, fixture);
	testInfo.annotations.push({
		type: 'guest-ops-api',
		description:
			`GuestOps probe for ${fixture.guestOs} nonce ${nonce} at ` +
			`${GUEST_OPS_CONTRACT.execPath(fixture.podId, fixture.vmId)} → HTTP ${guestOps.execStatus}; ` +
			`${GUEST_OPS_CONTRACT.filePath(fixture.podId, fixture.vmId)}?path=${nonceFileForGuest(fixture.guestOs)} ` +
			`→ HTTP ${guestOps.fileStatus}. selfservice-api has no guest-exec/guest-file endpoint in this ` +
			`synthetic repo's searchable surface; in-guest file readback remains blocked on that API. ` +
			`Load-bearing observation is KeyboardManager2, not canvas pixels/OCR.`
	});
}

test('console_guest_physical_keyboard_nonce', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Ubuntu console types a unique nonce through KeyboardManager2',
		description:
			'Opens a connected Ubuntu console fixture, types a unique nonce with Playwright physical ' +
			'keydown/keypress/keyup (not Paste or Text Input), and proves the nonce on the live CoreWMKS ' +
			'KeyboardManager2 guest-bound path. Canvas/DOM keydowns are collected as supporting evidence ' +
			'only; the check fails if keys never leave the canvas. True GuestOps file readback is blocked ' +
			'on a selfservice-api guest-exec/guest-file contract and is not faked via OCR.',
		severity: 'warning',
		runbook: RUNBOOK
	});

	await runPhysicalNonceGate(page, testInfo, UBUNTU_KEYBOARD_FIXTURE);
});

test('console_windows_physical_keyboard_control', async ({ authedPage: page }, testInfo) => {
	meta(testInfo, {
		title: 'Windows console keeps the same physical KeyboardManager2 path',
		description:
			'Control for the Ubuntu nonce gate: the same high-level physical keyboard path must still ' +
			'reach CoreWMKS KeyboardManager2 on a Windows console fixture. Paste and Text Input are not ' +
			'used. Canvas focus is not acceptance.',
		severity: 'warning',
		runbook: RUNBOOK
	});

	await runPhysicalNonceGate(page, testInfo, WINDOWS_KEYBOARD_FIXTURE);
});
