/** What a plain click on a VM does (tree row, overview name). Pure, unit tested. */
import type { Capabilities, VmInfo } from '@vmm/sdk';

export type PrimaryCommand = 'vmm.connectSerial' | 'vmm.openVmDashboard';

/**
 * A resource whose only console is a terminal (a Proxmox LXC container) has nothing to show on a
 * details page that the terminal does not beat, so clicking a running one opens the terminal.
 * Everything else opens the details page when the provider has inventory or statistics.
 */
export function primaryAction(vm: Pick<VmInfo, 'state' | 'consoles'>, caps: Capabilities | undefined): PrimaryCommand | undefined {
	if (!caps) return undefined;
	const consoles = vm.consoles ?? caps.consoles;
	const graphical = consoles.includes('vnc') || consoles.includes('rdp') || caps.preview;
	if (consoles.includes('serial') && !graphical && vm.state === 'running') return 'vmm.connectSerial';
	if (caps.details || caps.stats) return 'vmm.openVmDashboard';
	return undefined;
}
