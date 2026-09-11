import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	assertGuestNonceProof,
	createPhysicalNonce,
	GUEST_OPS_CONTRACT,
	GuestNonceProofError,
	physicalKeyForChar,
	UBUNTU_KEYBOARD_FIXTURE,
	WINDOWS_KEYBOARD_FIXTURE,
	type GuestNonceEvidence
} from '../tests/lib/console-keyboard.ts';

const SPEC_PATH = join(process.cwd(), 'tests/specs/console-guest-keyboard-nonce.spec.ts');
const LIB_PATH = join(process.cwd(), 'tests/lib/console-keyboard.ts');
const CANVAS_SPEC_PATH = join(
	process.cwd(),
	'tests/specs/console-and-provisioning-regressions.spec.ts'
);

function evidence(overrides: Partial<GuestNonceEvidence> & Pick<GuestNonceEvidence, 'nonce'>): GuestNonceEvidence {
	return {
		canvasKeyCodes: [],
		keyboardManagerKeyCodes: [],
		keyboardManagerChars: '',
		pasteOrTextInputUsed: false,
		guestFileContents: null,
		...overrides
	};
}

test('physical nonce is unique, lowercase, and modifier-free', () => {
	const first = createPhysicalNonce(1_700_000_000_000, 0.123456);
	const second = createPhysicalNonce(1_700_000_000_001, 0.987654);
	expect(first).toMatch(/^[a-z0-9]{8,16}$/);
	expect(second).toMatch(/^[a-z0-9]{8,16}$/);
	expect(first).not.toEqual(second);
	for (const char of first) {
		expect(physicalKeyForChar(char)).toMatch(/^(Key[A-Z]|Digit[0-9])$/);
	}
});

test('physical key map rejects characters that need Shift or paste', () => {
	expect(() => physicalKeyForChar('A')).toThrow('not physical-typeable');
	expect(() => physicalKeyForChar('-')).toThrow('not physical-typeable');
	expect(() => physicalKeyForChar('ab')).toThrow('single character');
});

test('sabotage: canvas-only keydowns cannot accept the nonce', () => {
	const nonce = 'nabc1234';
	const canvasKeyCodes = [...nonce].map(physicalKeyForChar);
	expect(() =>
		assertGuestNonceProof(
			evidence({
				nonce,
				canvasKeyCodes,
				keyboardManagerKeyCodes: [],
				keyboardManagerChars: ''
			})
		)
	).toThrow(GuestNonceProofError);
	expect(() =>
		assertGuestNonceProof(
			evidence({
				nonce,
				canvasKeyCodes,
				keyboardManagerKeyCodes: [],
				keyboardManagerChars: ''
			})
		)
	).toThrow('keys only hit the canvas capture target');
});

test('sabotage: Paste or Text Input cannot accept the nonce', () => {
	const nonce = 'nabc1234';
	expect(() =>
		assertGuestNonceProof(
			evidence({
				nonce,
				keyboardManagerChars: nonce,
				keyboardManagerKeyCodes: [...nonce].map(physicalKeyForChar),
				pasteOrTextInputUsed: true
			})
		)
	).toThrow('Paste or Text Input');
});

test('sabotage: GuestOps file contents without KeyboardManager2 is not acceptance', () => {
	const nonce = 'nabc1234';
	expect(() =>
		assertGuestNonceProof(
			evidence({
				nonce,
				guestFileContents: nonce,
				keyboardManagerChars: '',
				keyboardManagerKeyCodes: []
			})
		)
	).toThrow('not observed on the guest-bound KeyboardManager2 path');
});

test('KeyboardManager2 chars or codes accept the nonce even if the canvas also saw it', () => {
	const nonce = 'nxyz9876';
	const codes = [...nonce].map(physicalKeyForChar);
	expect(() =>
		assertGuestNonceProof(
			evidence({
				nonce,
				canvasKeyCodes: codes,
				keyboardManagerKeyCodes: codes,
				keyboardManagerChars: nonce
			})
		)
	).not.toThrow();
	expect(() =>
		assertGuestNonceProof(
			evidence({
				nonce,
				canvasKeyCodes: [],
				keyboardManagerKeyCodes: codes,
				keyboardManagerChars: ''
			})
		)
	).not.toThrow();
});

test('guest-ops contract is explicit and not implemented in this repo', () => {
	expect(GUEST_OPS_CONTRACT.execPath('pod-1', 'vm-1')).toBe(
		'/api/v1/pods/pod-1/vms/vm-1/guest/exec'
	);
	expect(GUEST_OPS_CONTRACT.filePath('pod-1', 'vm-1')).toBe(
		'/api/v1/pods/pod-1/vms/vm-1/guest/file'
	);
	expect(GUEST_OPS_CONTRACT.ubuntuNonceFile).toBe('/tmp/crucible-synth-nonce');
	expect(GUEST_OPS_CONTRACT.windowsNonceFile).toBe(
		'C:\\Windows\\Temp\\crucible-synth-nonce.txt'
	);
	expect(UBUNTU_KEYBOARD_FIXTURE.guestOs).toBe('ubuntu');
	expect(WINDOWS_KEYBOARD_FIXTURE.guestOs).toBe('windows');
});

test('Gate B2 spec types physically and never uses Paste, fill, or insertText', () => {
	const spec = readFileSync(SPEC_PATH, 'utf8');
	const lib = readFileSync(LIB_PATH, 'utf8');
	for (const source of [spec, lib]) {
		expect(source).not.toMatch(/insertText/);
		expect(source).not.toMatch(/\.fill\(/);
		expect(source).not.toMatch(/navigator\.clipboard/);
		expect(source).not.toMatch(/keyboard\.type\(/);
	}
	expect(spec).toContain('typePhysicalNonce');
	expect(spec).toContain("test('console_guest_physical_keyboard_nonce'");
	expect(spec).toContain("test('console_windows_physical_keyboard_control'");
	expect(spec).toContain('assertGuestNonceProof');
	expect(spec).not.toMatch(/sendInputString\(/);
	expect(lib).toContain('page.keyboard.press');
	expect(lib).toContain('wmksData: { _keyboardManager: keyboardManagerProxy }');
	// Stub must mirror SDK this.element.bind("keydown.wmks") — otherwise UI
	// synth onto #console-canvas never reaches KeyboardManager2 (Gate B2 red).
	expect(lib).toContain("container.addEventListener('keydown'");
	expect(lib).toContain('keyboardManagerProxy.onKeyDown(event)');
});

test('existing canvas check stays supporting evidence, not Gate B2 acceptance', () => {
	const canvasSpec = readFileSync(CANVAS_SPEC_PATH, 'utf8');
	expect(canvasSpec).toContain("test('console_canvas_keeps_physical_keyboard_delivery'");
	expect(canvasSpec).toContain('Supporting evidence only');
	expect(canvasSpec).toContain('console_guest_physical_keyboard_nonce owns the KeyboardManager2 nonce path');
});
