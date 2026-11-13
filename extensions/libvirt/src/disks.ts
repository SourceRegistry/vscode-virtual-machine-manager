/** Pure helpers for adding disks to a libvirt domain. No I/O, unit tested. */

/** The device-name prefix libvirt and Linux guests use for a bus. */
export function targetPrefix(bus: string | undefined): string {
	switch (bus) {
		case 'ide':
			return 'hd';
		case 'sata':
		case 'scsi':
		case 'usb':
			return 'sd';
		default:
			return 'vd';
	}
}

/** `vda`, `vdb`, … `vdz`, `vdaa`, …: the first target of the bus's prefix that no device of the domain uses. */
export function nextTarget(used: string[], bus: string | undefined): string {
	const prefix = targetPrefix(bus);
	const taken = new Set(used);
	for (let n = 0; n < 26 * 27; n++) {
		const suffix = n < 26 ? String.fromCharCode(97 + n) : String.fromCharCode(96 + Math.floor(n / 26)) + String.fromCharCode(97 + (n % 26));
		if (!taken.has(prefix + suffix)) return prefix + suffix;
	}
	throw new Error('The domain has no free disk name left.');
}

/** `Capacity:` and `Allocation:` from `virsh domblkinfo`, in bytes. */
export function parseBlkinfo(output: string): { capacity?: number; allocation?: number } {
	const value = (label: string) => {
		const match = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(output);
		return match ? Number(match[1]) : undefined;
	};
	return { capacity: value('Capacity'), allocation: value('Allocation') };
}

const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * The domain XML with one more disk. libvirt gives it a PCI address (and a PCIe root port for it) when the
 * domain is defined, which `attach-disk --config` does not do on an aarch64 `virt` machine with none spare.
 */
export function withDisk(domainXml: string, disk: { file: string; target: string; bus: string; format: string }): string {
	const at = domainXml.lastIndexOf('</devices>');
	if (at < 0) throw new Error('The domain definition has no devices.');
	const element = `  <disk type='file' device='disk'>\n      <driver name='qemu' type='${escape(disk.format)}'/>\n      <source file='${escape(disk.file)}'/>\n      <target dev='${escape(disk.target)}' bus='${escape(disk.bus)}'/>\n    </disk>\n  `;
	return domainXml.slice(0, at) + element + domainXml.slice(at);
}

/**
 * The image format from the first bytes of the file (and its last 512, for a fixed VHD): libvirt has to be told,
 * it does not guess for a file it is handed. `undefined` for a VMDK that is only a descriptor of other files.
 */
export function sniffFormat(head: Buffer, tail?: Buffer): string | undefined {
	const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1');
	if (ascii(0, 4) === 'QFI\xfb') return 'qcow2';
	if (ascii(0, 4) === 'KDMV') return 'vmdk';
	if (ascii(0, 21) === '# Disk DescriptorFile') return undefined;
	if (ascii(0, 8) === 'vhdxfile') return 'vhdx';
	if (head.length >= 0x44 && head.readUInt32LE(0x40) === 0xbeda107f) return 'vdi';
	if (ascii(0, 8) === 'conectix' || tail?.subarray(0, 8).toString('latin1') === 'conectix') return 'vpc';
	return 'raw';
}

/** File extension for a format in a volume name. */
export function volumeExtension(format: string): string {
	return format === 'raw' ? 'img' : format === 'vpc' ? 'vhd' : format;
}
