import { test, expect } from '@playwright/test';
import { registerLifecycleCheck } from '../tests/lib/lifecycle.ts';

test('enabled lifecycle check registers', () => {
	const registrations: string[] = [];
	registerLifecycleCheck(true, () => registrations.push('destructive'));
	expect(registrations).toEqual(['destructive']);
});

test('disabled lifecycle check is not registered or invoked', () => {
	let destructiveInvocations = 0;

	registerLifecycleCheck(false, () => {
		destructiveInvocations += 1;
	});

	expect(destructiveInvocations, 'sabotage guard: destructive body must never run').toBe(0);
});
