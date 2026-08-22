import type { Locator, TestInfo } from '@playwright/test';

export const MAINTENANCE_MESSAGE =
	'Provisioning is temporarily unavailable for maintenance.';

export interface ControlState {
	present: boolean;
	nativeDisabled?: boolean;
	ariaDisabled?: string | null;
	href?: string | null;
	tagName?: string;
}

export function isUnavailableOrDisabled(state: ControlState): boolean {
	if (!state.present) return true;
	if (state.nativeDisabled || state.ariaDisabled === 'true') return true;
	return state.tagName?.toLowerCase() === 'a' && !state.href;
}

export async function expectControlsUnavailableOrDisabled(
	controls: Locator,
	description: string
): Promise<void> {
	const count = await controls.count();
	for (let index = 0; index < count; index += 1) {
		const control = controls.nth(index);
		if (!(await control.isVisible())) continue;

		const state: ControlState = {
			present: true,
			nativeDisabled: await control.isDisabled(),
			ariaDisabled: await control.getAttribute('aria-disabled'),
			href: await control.getAttribute('href'),
			tagName: await control.evaluate((element) => element.tagName)
		};
		if (!isUnavailableOrDisabled(state)) {
			throw new Error(`${description} must be disabled or unavailable during maintenance`);
		}
	}
}

interface PodSummary {
	id: string;
	status?: string;
}

export function parsePodSummaries(body: unknown): PodSummary[] {
	const candidates =
		body === null
			? []
			: Array.isArray(body)
			? body
			: typeof body === 'object' &&
					'pods' in body &&
					Array.isArray(body.pods)
				? body.pods
				: null;

	if (!candidates) {
		throw new Error('GET /api/v1/pods returned neither an array nor an object with a pods array');
	}

	return candidates.map((pod, index) => {
		if (typeof pod !== 'object' || pod === null || !('id' in pod) || typeof pod.id !== 'string') {
			throw new Error(`GET /api/v1/pods returned an invalid pod at index ${index}`);
		}
		return {
			id: pod.id,
			status: 'status' in pod && typeof pod.status === 'string' ? pod.status : undefined
		};
	});
}

export function recordMaintenanceLimitation(
	testInfo: TestInfo,
	description: string
): void {
	testInfo.annotations.push({
		type: 'maintenance-resource-coverage',
		description
	});
}
