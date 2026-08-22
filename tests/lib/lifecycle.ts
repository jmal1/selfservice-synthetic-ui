export function registerLifecycleCheck(
	enabled: boolean,
	register: () => unknown
): void {
	if (!enabled) return;
	register();
}
