import { test, expect } from '@playwright/test';
import {
	isUnavailableOrDisabled,
	parsePodSummaries
} from '../tests/lib/maintenance.ts';

test('maintenance control accepts absent and disabled controls', () => {
	expect(isUnavailableOrDisabled({ present: false })).toBe(true);
	expect(isUnavailableOrDisabled({ present: true, nativeDisabled: true })).toBe(true);
	expect(isUnavailableOrDisabled({ present: true, ariaDisabled: 'true' })).toBe(true);
	expect(isUnavailableOrDisabled({ present: true, tagName: 'A', href: null })).toBe(true);
});

test('maintenance control rejects actionable provisioning controls', () => {
	expect(
		isUnavailableOrDisabled({
			present: true,
			nativeDisabled: false,
			ariaDisabled: 'false',
			tagName: 'A',
			href: '/pods/new'
		})
	).toBe(false);
});

test('pod response parsing supports current API envelopes and a null empty list', () => {
	expect(parsePodSummaries([{ id: 'pod-1', status: 'active' }])).toEqual([
		{ id: 'pod-1', status: 'active' }
	]);
	expect(parsePodSummaries({ pods: [{ id: 'pod-2' }] })).toEqual([
		{ id: 'pod-2', status: undefined }
	]);
	expect(parsePodSummaries(null)).toEqual([]);
});

test('pod response parsing rejects malformed response shapes', () => {
	for (const body of [{ data: [] }, { pods: null }, {}, 'not-json-list']) {
		expect(() => parsePodSummaries(body)).toThrow(
			'GET /api/v1/pods returned neither an array nor an object with a pods array'
		);
	}
});
