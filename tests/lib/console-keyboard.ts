// Gate B2 helpers: physical keyboard delivery into CoreWMKS KeyboardManager2.
//
// `console_canvas_keeps_physical_keyboard_delivery` is supporting evidence that
// the persistent #console-canvas capture target can receive browser keydowns.
// That is NOT acceptance. Acceptance is a unique nonce observed on the
// guest-bound KeyboardManager2 path (the live CoreWMKS object). The UI
// preventDefaults page keys and re-dispatches synth KeyboardEvents onto
// #console-canvas so the SDK's keydown.wmks bind (this.element) still runs.
//
// True in-guest readback (VMware GuestOps cat/type of a nonce file) is a
// separate selfservice-api contract. This repo must not invent that API.
// See GUEST_OPS_CONTRACT and the Gate B2 PR body.

import { type Page } from '@playwright/test';

export const GUEST_OPS_CONTRACT = {
	execPath: (podId: string, vmId: string) =>
		`/api/v1/pods/${podId}/vms/${vmId}/guest/exec`,
	filePath: (podId: string, vmId: string) =>
		`/api/v1/pods/${podId}/vms/${vmId}/guest/file`,
	ubuntuNonceFile: '/tmp/crucible-synth-nonce',
	windowsNonceFile: 'C:\\Windows\\Temp\\crucible-synth-nonce.txt'
} as const;

export type GuestOs = 'ubuntu' | 'windows';

export interface ConsoleKeyboardFixture {
	guestOs: GuestOs;
	podId: string;
	vmId: string;
	displayName: string;
}

export const UBUNTU_KEYBOARD_FIXTURE: ConsoleKeyboardFixture = {
	guestOs: 'ubuntu',
	podId: 'synthetic-ubuntu-kbd-pod',
	vmId: 'synthetic-ubuntu-kbd-vm',
	displayName: 'Synthetic Ubuntu keyboard VM'
};

export const WINDOWS_KEYBOARD_FIXTURE: ConsoleKeyboardFixture = {
	guestOs: 'windows',
	podId: 'synthetic-windows-kbd-pod',
	vmId: 'synthetic-windows-kbd-vm',
	displayName: 'Synthetic Windows keyboard VM'
};

export interface GuestNonceEvidence {
	nonce: string;
	canvasKeyCodes: string[];
	keyboardManagerKeyCodes: string[];
	keyboardManagerChars: string;
	pasteOrTextInputUsed: boolean;
	guestFileContents: string | null;
}

export class GuestNonceProofError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GuestNonceProofError';
	}
}

export function createPhysicalNonce(now = Date.now(), random = Math.random()): string {
	const raw = `n${now.toString(36)}${random.toString(36).replace('.', '')}`;
	const nonce = raw.replace(/[^a-z0-9]/g, '').slice(0, 16);
	if (nonce.length < 8 || /[^a-z0-9]/.test(nonce)) {
		throw new Error('failed to mint a unique lowercase alphanumeric nonce');
	}
	return nonce;
}

export function physicalKeyForChar(char: string): string {
	if (char.length !== 1) {
		throw new Error(`expected a single character, got ${JSON.stringify(char)}`);
	}
	if (char >= 'a' && char <= 'z') return `Key${char.toUpperCase()}`;
	if (char >= '0' && char <= '9') return `Digit${char}`;
	throw new Error(
		`nonce character ${JSON.stringify(char)} is not physical-typeable without modifiers`
	);
}

export async function typePhysicalNonce(page: Page, nonce: string): Promise<void> {
	for (const char of nonce) {
		await page.keyboard.press(physicalKeyForChar(char));
	}
}

export function nonceFileForGuest(guestOs: GuestOs): string {
	return guestOs === 'windows'
		? GUEST_OPS_CONTRACT.windowsNonceFile
		: GUEST_OPS_CONTRACT.ubuntuNonceFile;
}

export function assertGuestNonceProof(evidence: GuestNonceEvidence): void {
	if (evidence.pasteOrTextInputUsed) {
		throw new GuestNonceProofError(
			'nonce was delivered via Paste or Text Input; Gate B2 requires physical keyboard events'
		);
	}

	const expectedCodes = [...evidence.nonce].map(physicalKeyForChar);
	const managerHasNonce =
		evidence.keyboardManagerChars.includes(evidence.nonce) ||
		expectedCodes.every((code) => evidence.keyboardManagerKeyCodes.includes(code));
	const canvasHasKeys = expectedCodes.every((code) =>
		evidence.canvasKeyCodes.includes(code)
	);
	const guestFileHasNonce =
		evidence.guestFileContents !== null &&
		evidence.guestFileContents.includes(evidence.nonce);

	if (!managerHasNonce && canvasHasKeys) {
		throw new GuestNonceProofError(
			'keys only hit the canvas capture target; live CoreWMKS KeyboardManager2 did not receive the nonce'
		);
	}

	if (!managerHasNonce) {
		throw new GuestNonceProofError(
			'nonce was not observed on the guest-bound KeyboardManager2 path; ' +
				'DOM focus and canvas keydowns are not acceptance' +
				(guestFileHasNonce
					? ' (GuestOps file contents are not a substitute when KeyboardManager2 was bypassed)'
					: '')
		);
	}
}

export async function installKeyboardManager2Stub(
	page: Page,
	fixture: ConsoleKeyboardFixture
): Promise<void> {
	await page.route('**/wmks/wmks.js', async (route) => {
		await route.fulfill({
			contentType: 'application/javascript',
			body: keyboardManager2StubSource(fixture.guestOs)
		});
	});
	await page.route(`**/api/v1/pods/${fixture.podId}`, async (route) => {
		if (route.request().method() !== 'GET') {
			await route.fallback();
			return;
		}
		await route.fulfill({
			json: {
				id: fixture.podId,
				status: 'active',
				vms: [
					{
						id: fixture.vmId,
						display_name: fixture.displayName,
						vcenter_vm_name: fixture.vmId,
						status: 'running',
						guest_os: fixture.guestOs
					}
				]
			}
		});
	});
}

export async function attachCanvasKeySpy(page: Page): Promise<void> {
	const canvasContainer = page.locator('#console-canvas');
	await canvasContainer.evaluate((element) => {
		const target = element as HTMLElement & { receivedKeys?: string[] };
		target.receivedKeys = [];
		element.addEventListener('keydown', (event) => {
			target.receivedKeys?.push((event as KeyboardEvent).code);
		});
	});
}

export async function readCanvasKeyCodes(page: Page): Promise<string[]> {
	return page.locator('#console-canvas').evaluate(
		(element) =>
			(element as HTMLElement & { receivedKeys?: string[] }).receivedKeys ?? []
	);
}

export async function readKeyboardManagerEvidence(page: Page): Promise<{
	codes: string[];
	chars: string;
	pasteCalls: string[];
	sendKeyCodesCalls: unknown[][];
}> {
	return page.evaluate(() => {
		const stub = (
			window as typeof window & {
				__wmksStub?: {
					keyboardState?: { codes: string[]; chars: string };
					pasteCalls?: string[];
					sendKeyCodesCalls?: unknown[][];
				};
			}
		).__wmksStub;
		return {
			codes: stub?.keyboardState?.codes ?? [],
			chars: stub?.keyboardState?.chars ?? '',
			pasteCalls: stub?.pasteCalls ?? [],
			sendKeyCodesCalls: stub?.sendKeyCodesCalls ?? []
		};
	});
}

export async function probeGuestOps(
	page: Page,
	fixture: ConsoleKeyboardFixture
): Promise<{ execStatus: number; fileStatus: number }> {
	const execUrl = GUEST_OPS_CONTRACT.execPath(fixture.podId, fixture.vmId);
	const fileUrl = `${GUEST_OPS_CONTRACT.filePath(fixture.podId, fixture.vmId)}?path=${encodeURIComponent(
		nonceFileForGuest(fixture.guestOs)
	)}`;
	const execResp = await page.request.post(execUrl, {
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		failOnStatusCode: false,
		data:
			fixture.guestOs === 'windows'
				? {
						program: 'C:\\Windows\\System32\\cmd.exe',
						arguments: ['/c', 'type', GUEST_OPS_CONTRACT.windowsNonceFile]
					}
				: {
						program: '/bin/cat',
						arguments: [GUEST_OPS_CONTRACT.ubuntuNonceFile]
					}
	});
	const fileResp = await page.request.get(fileUrl, {
		headers: { accept: 'application/json' },
		failOnStatusCode: false
	});
	return { execStatus: execResp.status(), fileStatus: fileResp.status() };
}

function keyboardManager2StubSource(guestOs: GuestOs): string {
	return `
				(() => {
					const events = {
						CONNECTION_STATE_CHANGE: 'connection-state-change',
						ERROR: 'error'
					};
					const connectionState = {
						CONNECTED: 'connected',
						DISCONNECTED: 'disconnected'
					};
					const keyboardState = { codes: [], chars: '', events: [] };
					const pasteCalls = [];
					const sendKeyCodesCalls = [];

					const ingest = (type, event) => {
						const code = event && event.code ? String(event.code) : '';
						const key = event && event.key != null ? String(event.key) : '';
						keyboardState.events.push({ type: type || (event && event.type) || 'keydown', code, key });
						if ((type || (event && event.type) || 'keydown') === 'keydown' && code) {
							keyboardState.codes.push(code);
						}
						if ((type || (event && event.type) || 'keydown') === 'keydown' && key.length === 1) {
							keyboardState.chars += key;
						}
					};

					const handlerNames = [
						'onKeyDown', 'onKeyUp', 'onKeyPress',
						'handleKeyDown', 'handleKeyUp', 'handleKeyPress',
						'keydown', 'keyup', 'keypress',
						'processKeyEvent', 'handleKeyboardEvent'
					];
					const keyboardManager = {};
					for (const name of handlerNames) {
						keyboardManager[name] = function (event) {
							const lowered = name.toLowerCase();
							const type = lowered.includes('up')
								? 'keyup'
								: lowered.includes('press')
									? 'keypress'
									: (event && event.type) || 'keydown';
							ingest(type, event);
						};
					}

					const keyboardManagerProxy = new Proxy(keyboardManager, {
						get(target, prop) {
							if (prop in target) return target[prop];
							if (typeof prop !== 'string') return undefined;
							return function (event) {
								if (event && typeof event === 'object' && ('type' in event || 'code' in event || 'key' in event)) {
									ingest(event.type || 'keydown', event);
								}
							};
						}
					});

					window.WMKS = {
						CONST: {
							Events: events,
							ConnectionState: connectionState,
							Position: { CENTER: 'center' }
						},
						createWMKS(containerId) {
							const callbacks = new Map();
							const container = document.getElementById(containerId);
							let generation = 0;
							const mountCanvas = () => {
								generation += 1;
								const canvas = document.createElement('canvas');
								canvas.id = 'mainCanvas';
								canvas.width = 800;
								canvas.height = 600;
								canvas.dataset.wmksGeneration = String(generation);
								canvas.dataset.guestOs = ${JSON.stringify(guestOs)};
								container.replaceChildren(canvas);
							};
							mountCanvas();

							// Mirror CoreWMKS connectEvents: this.element.bind("keydown.wmks", …)
							// → _keyboardManager.onKeyDown. UI synth dispatches onto #console-canvas
							// (this.element); without this bind, Gate B2 only sees canvas spies.
							const onWidgetKeydown = (event) => {
								keyboardManagerProxy.onKeyDown(event);
							};
							const onWidgetKeyup = (event) => {
								keyboardManagerProxy.onKeyUp(event);
							};
							const onWidgetKeypress = (event) => {
								keyboardManagerProxy.onKeyPress(event);
							};
							container.addEventListener('keydown', onWidgetKeydown);
							container.addEventListener('keyup', onWidgetKeyup);
							container.addEventListener('keypress', onWidgetKeypress);

							const instance = {
								wmksData: { _keyboardManager: keyboardManagerProxy },
								_keyboardManager: keyboardManagerProxy,
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
								sendInputString(text) {
									pasteCalls.push(String(text ?? ''));
								},
								sendKeyCodes(keys) {
									sendKeyCodesCalls.push(keys);
								},
								disconnect() {},
								destroy() {
									container.removeEventListener('keydown', onWidgetKeydown);
									container.removeEventListener('keyup', onWidgetKeyup);
									container.removeEventListener('keypress', onWidgetKeypress);
								}
							};

							window.__wmksStub = {
								keyboardManager: keyboardManagerProxy,
								keyboardState,
								pasteCalls,
								sendKeyCodesCalls,
								instance,
								reconnect: mountCanvas
							};
							return instance;
						}
					};
				})();
			`;
}
