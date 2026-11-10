import type { VmDefinition } from './definition';

/**
 * The definition of a clone: everything of the original except what must not be shared. The disks are
 * the clone's own copies, the MAC address is new, and what only one machine can own is left out: port
 * forwards (the host ports would clash when both run), passed-through host devices, and the "attached from
 * outside" markers (a clone is always a VM managed here, even of an imported or attached original), and the template flag (a clone of a template is a machine).
 */
export function cloneDefinition(source: VmDefinition, clone: { id: string; name: string; disks: string[]; mac: string; now: number }): VmDefinition {
	const { forwards: _forwards, pciDevices: _pciDevices, origin: _origin, template: _template, ...kept } = source;
	return { ...kept, id: clone.id, name: clone.name, disks: clone.disks, mac: clone.mac, createdAt: clone.now };
}
