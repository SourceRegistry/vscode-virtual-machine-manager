/** Badge for guests that are not plain VMs (an LXC container on Proxmox). */
export function guestLabel(vm: { guestKind?: 'vm' | 'container' }): string | undefined {
	return vm.guestKind === 'container' ? 'container' : undefined;
}

/** Short badge for VMs that were not created by the provider's own create flow. */
export function originLabel(vm: { origin?: 'adopted' | 'imported'; controllable?: boolean; template?: boolean }): string | undefined {
	if (vm.template) return 'template';
	if (vm.origin === 'adopted') return vm.controllable === false ? 'external · observe only' : 'external';
	return vm.origin === 'imported' ? 'imported' : undefined;
}
