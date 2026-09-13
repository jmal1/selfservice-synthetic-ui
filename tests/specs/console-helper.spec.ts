import { type Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { meta } from '../lib/synthetic.ts';

const POD_ID = 'synthetic-helper-pod';
const VM_ID = 'synthetic-helper-vm';

type HelperVmOverrides = {
	assign_ip?: boolean;
	skip_generalize?: boolean;
	ip_address?: string;
	generated_username?: string;
	generated_password?: string;
	template_kind?: string;
};

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
							container.replaceChildren(canvas);
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

async function stubPod(page: Page, overrides: HelperVmOverrides = {}): Promise<void> {
	await page.route(`**/api/v1/pods/${POD_ID}`, async (route) => {
		await route.fulfill({
			json: {
				id: POD_ID,
				status: 'active',
				vlan_id: 102,
				subnet: '10.100.2.0/24',
				vms: [
					{
						id: VM_ID,
						display_name: 'Helper VM',
						vcenter_vm_name: 'helper-vm',
						status: 'running',
						os_type: 'linux',
						template_kind: overrides.template_kind ?? 'clone_with_customize',
						assign_ip: overrides.assign_ip ?? true,
						skip_generalize: overrides.skip_generalize ?? false,
						ip_address: overrides.ip_address ?? '',
						generated_username: overrides.generated_username ?? 'student',
						generated_password: overrides.generated_password ?? 'HelperPw1!',
						default_username: '',
						default_password: ''
					}
				]
			}
		});
	});
}

async function openHelperConsole(page: Page, overrides: HelperVmOverrides = {}): Promise<void> {
	await installWmksTransportStub(page);
	await stubPod(page, overrides);
	await page.goto(`/console/${POD_ID}/${VM_ID}`);
	await expect(page.getByText('Connected', { exact: true })).toBeVisible();
	await expect(page.getByTestId('console-helper')).toBeVisible();
}

test('console_helper_shows_credentials_without_network_for_generalized_vm', async (
	{ authedPage: page },
	testInfo
) => {
	meta(testInfo, {
		title: 'Console helper shows credentials for generalized VMs',
		description:
			'Stubbed student console proves the credentials section is visible with copyable username while the network helper stays hidden for assign_ip=true and skip_generalize=false.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#runbook'
	});

	await openHelperConsole(page, {
		assign_ip: true,
		skip_generalize: false,
		generated_username: 'student',
		generated_password: 'HelperPw1!'
	});

	const creds = page.getByTestId('console-helper-credentials');
	await expect(creds).toBeVisible();
	await expect(creds.getByText('student', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Copy User' })).toBeVisible();
	await expect(page.getByTestId('console-helper-network')).toHaveCount(0);

	await expect(page.getByRole('button', { name: 'Copy User' })).toBeEnabled();
});

test('console_helper_shows_network_for_skip_generalize', async (
	{ authedPage: page },
	testInfo
) => {
	meta(testInfo, {
		title: 'Console helper network section for skip_generalize',
		description:
			'Stubbed console with skip_generalize=true shows VLAN, subnet, and observed IP in the network helper alongside credentials.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#runbook'
	});

	await openHelperConsole(page, {
		skip_generalize: true,
		assign_ip: true,
		ip_address: '10.100.2.17',
		template_kind: 'clone_no_customize'
	});

	const network = page.getByTestId('console-helper-network');
	await expect(network).toBeVisible();
	await expect(network.getByText('102', { exact: true })).toBeVisible();
	await expect(network.getByText('10.100.2.0/24', { exact: true })).toBeVisible();
	await expect(network.getByText('10.100.2.17', { exact: true })).toBeVisible();
	await expect(page.getByTestId('console-helper-credentials')).toBeVisible();
});

test('console_helper_shows_network_for_assign_ip_false', async (
	{ authedPage: page },
	testInfo
) => {
	meta(testInfo, {
		title: 'Console helper network section when assign_ip is false',
		description:
			'Stubbed console with assign_ip=false shows the network helper even when skip_generalize is false.',
		severity: 'warning',
		runbook:
			'https://github.com/jmal1/Homelab/blob/main/future/Synthetic-Monitoring.md#runbook'
	});

	await openHelperConsole(page, {
		assign_ip: false,
		skip_generalize: false
	});

	await expect(page.getByTestId('console-helper-network')).toBeVisible();
	await expect(page.getByTestId('console-helper-credentials')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Copy User' })).toBeEnabled();
});
