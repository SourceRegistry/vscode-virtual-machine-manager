import { describe, expect, it } from 'vitest';
import { asArray, formatMac, toDetails, toStats } from '../src/inspect';

describe('Hyper-V inventory mapping', () => {
	it('normalises PowerShell single-object / null output', () => {
		expect(asArray(null)).toEqual([]);
		expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
		expect(asArray([1, 2])).toEqual([1, 2]);
	});

	it('formats MAC addresses', () => {
		expect(formatMac('00155D010203')).toBe('00:15:5d:01:02:03');
		expect(formatMac('')).toBeUndefined();
		expect(formatMac('weird')).toBe('weird');
	});

	it('maps disks, DVD drives and NICs', () => {
		const details = toDetails({
			Generation: 2,
			Disks: [
				{ Id: 'SCSI:0:0', Kind: 'disk', Path: 'C:\\vhd\\a.vhdx', SizeBytes: 1024, Format: 'VHDX' },
				{ Id: 'SCSI:0:1', Kind: 'cdrom', Path: '', SizeBytes: null, Format: 'iso' }
			],
			Nics: {
				Name: 'Network Adapter',
				Mac: '00155D010203',
				Switch: 'Default Switch',
				Ips: ['fe80::1', '2001:db8::2', '172.20.0.5'],
				Connected: true,
				Legacy: false
			}
		});
		expect(details.disks).toEqual([
			{ id: 'SCSI:0:0', kind: 'disk', label: 'Hard disk 1', path: 'C:\\vhd\\a.vhdx', sizeBytes: 1024, format: 'vhdx', bus: 'scsi', readOnly: undefined, removable: undefined },
			{ id: 'SCSI:0:1', kind: 'cdrom', label: 'DVD drive 1', path: undefined, sizeBytes: undefined, format: 'iso', bus: 'scsi', readOnly: true, removable: true }
		]);
		expect(details.nics).toEqual([
			{
				id: 'Network Adapter',
				label: 'Network Adapter',
				model: 'Synthetic network adapter',
				mac: '00:15:5d:01:02:03',
				network: 'Default Switch',
				ipAddresses: ['172.20.0.5', '2001:db8::2'],
				connected: true
			}
		]);
	});

	it('handles a VM without drives or adapters', () => {
		expect(toDetails({ Generation: 1, Disks: null, Nics: null })).toEqual({ disks: [], nics: [], devices: [], forwards: [] });
	});

	it('converts stats, preferring memory demand', () => {
		expect(toStats({ CpuPercent: 25, AssignedMB: 2048, DemandMB: 900, StartupMB: 1024 }, 5)).toEqual({ timestamp: 5, cpuUsage: 0.25, memoryUsedMB: 900, memoryMB: 2048 });
		expect(toStats({ CpuPercent: 250, AssignedMB: 0, DemandMB: 0, StartupMB: 1024 }, 5)).toEqual({ timestamp: 5, cpuUsage: 1, memoryUsedMB: 0, memoryMB: 1024 });
		expect(toStats({ CpuPercent: null, AssignedMB: null, DemandMB: null, StartupMB: null }, 5).cpuUsage).toBeUndefined();
	});
});
