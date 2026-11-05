import { describe, expect, it } from 'vitest';
import { agentAddresses, containerAddresses, diskDevices, hostDevices, mergeAddresses, nicDevices, parseSize } from '../src/inventory';

describe('Proxmox hardware inventory', () => {
	it('parses sizes', () => {
		expect(parseSize('32G')).toBe(32 * 1024 ** 3);
		expect(parseSize('512M')).toBe(512 * 1024 ** 2);
		expect(parseSize('1T')).toBe(1024 ** 4);
		expect(parseSize('2048')).toBe(2048);
		expect(parseSize(undefined)).toBeUndefined();
		expect(parseSize('x')).toBeUndefined();
	});

	it('lists VM disks and drives, ignoring unrelated keys', () => {
		const disks = diskDevices({
			name: 'vm', scsi0: 'local-lvm:vm-100-disk-0,iothread=1,size=50G', ide2: 'local:iso/ubuntu.iso,media=cdrom,size=1G', sata0: 'none,media=cdrom',
			virtio1: 'ceph:vm-100-disk-1,size=100G,ro=1', efidisk0: 'local-lvm:vm-100-disk-2,size=4M', scsihw: 'virtio-scsi-single'
		}, false);
		expect(disks.map((d) => d.id)).toEqual(['ide2', 'sata0', 'scsi0', 'virtio1']);
		expect(disks.find((d) => d.id === 'scsi0')).toMatchObject({ kind: 'disk', path: 'local-lvm:vm-100-disk-0', sizeBytes: 50 * 1024 ** 3, bus: 'scsi', label: 'SCSI 0' });
		expect(disks.find((d) => d.id === 'ide2')).toMatchObject({ kind: 'cdrom', path: 'local:iso/ubuntu.iso', removable: true });
		expect(disks.find((d) => d.id === 'sata0')).toMatchObject({ kind: 'cdrom', path: undefined });
		expect(disks.find((d) => d.id === 'virtio1')?.readOnly).toBe(true);
	});

	it('lists a container root file system and mount points', () => {
		const disks = diskDevices({ rootfs: 'local-lvm:vm-105-disk-0,size=8G', mp0: '/srv/data,mp=/data,size=100G', hostname: 'ct' }, true);
		expect(disks).toMatchObject([{ id: 'mp0', label: 'Mount 0' }, { id: 'rootfs', label: 'Root file system', sizeBytes: 8 * 1024 ** 3 }]);
	});

	it('lists VM adapters with model, MAC, bridge and VLAN', () => {
		const nics = nicDevices({ net0: 'virtio=bc:24:11:aa:bb:cc,bridge=vmbr0,tag=20,firewall=1', net1: 'e1000=BC:24:11:00:00:01,bridge=vmbr1,link_down=1' }, false);
		expect(nics[0]).toMatchObject({ id: 'net0', model: 'virtio', mac: 'BC:24:11:AA:BB:CC', network: 'vmbr0 · VLAN 20' });
		expect(nics[1]).toMatchObject({ model: 'e1000', connected: false });
	});

	it('lists container adapters, with a static address and none for DHCP', () => {
		const nics = nicDevices({ net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:12:34:56,ip=10.0.0.5/24', net1: 'name=eth1,bridge=vmbr0,hwaddr=BC:24:11:12:34:57,ip=dhcp' }, true);
		expect(nics[0]).toMatchObject({ label: 'eth0', mac: 'BC:24:11:12:34:56', ipAddresses: ['10.0.0.5'] });
		expect(nics[1]?.ipAddresses).toBeUndefined();
	});

	it('lists passthrough and serial devices', () => {
		const devices = hostDevices({ hostpci0: '0000:01:00.0,pcie=1', usb0: 'host=1234:5678', serial0: 'socket', cores: 2 });
		expect(devices).toMatchObject([{ id: 'hostpci0', kind: 'pci', address: '0000:01:00.0' }, { id: 'usb0', kind: 'usb', address: '1234:5678' }, { id: 'serial0', kind: 'other' }]);
	});

	it('reads addresses from the guest agent and puts them on the matching adapter', () => {
		const reported = agentAddresses({ result: [
			{ name: 'lo', 'hardware-address': '00:00:00:00:00:00', 'ip-addresses': [{ 'ip-address': '127.0.0.1' }] },
			{ name: 'ens18', 'hardware-address': 'bc:24:11:aa:bb:cc', 'ip-addresses': [{ 'ip-address': '192.168.1.20' }, { 'ip-address': 'fe80::1' }, { 'ip-address': '2001:db8::5' }] }
		] });
		expect([...reported.keys()]).toEqual(['bc:24:11:aa:bb:cc']);
		const nics = mergeAddresses(nicDevices({ net0: 'virtio=BC:24:11:AA:BB:CC,bridge=vmbr0' }, false), reported);
		expect(nics[0]?.ipAddresses).toEqual(['192.168.1.20', '2001:db8::5']);
	});

	it('reads container interface addresses and tolerates odd replies', () => {
		const reported = containerAddresses([{ name: 'eth0', hwaddr: 'BC:24:11:12:34:56', inet: '10.0.0.7/24', inet6: 'fe80::1/64' }, { name: 'lo', hwaddr: '00:00:00:00:00:00', inet: '127.0.0.1/8' }]);
		expect(reported.get('bc:24:11:12:34:56')).toEqual(['10.0.0.7']);
		expect(agentAddresses(undefined).size).toBe(0);
		expect(containerAddresses('x').size).toBe(0);
	});
});
