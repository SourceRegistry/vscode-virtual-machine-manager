/** Short badge for VMs that were not created by the provider's own create flow. */
export function originLabel(vm: { origin?: 'adopted' | 'imported'; controllable?: boolean; template?: boolean }): string | undefined {
	if (vm.template) return 'template';
	if (vm.origin === 'adopted') return vm.controllable === false ? 'external · observe only' : 'external';
	return vm.origin === 'imported' ? 'imported' : undefined;
}
