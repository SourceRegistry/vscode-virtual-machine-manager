import { describe, expect, it } from 'vitest';
import { mapState, toVmInfo } from '../src/HyperVProvider';
import { buildCommand } from '../src/PowerShellSession';

describe('Hyper-V state mapping', () => {
	it('maps Hyper-V states to VM states', () => {
		expect(mapState('Running')).toBe('running');
		expect(mapState('Off')).toBe('stopped');
		expect(mapState('Saved')).toBe('saved');
		expect(mapState('Paused')).toBe('paused');
		expect(mapState('Stopping')).toBe('stopping');
		expect(mapState('Starting')).toBe('starting');
		expect(mapState('Other')).toBe('unknown');
	});

	it('converts raw Get-VM output', () => {
		const vm = toVmInfo({
			Id: '6b1ab849-11fc-48fc-8bcd-179abb91f4ae',
			Name: 'web',
			State: 'Running',
			Cpus: 4,
			MemoryMB: 3000,
			StartupMB: 4096,
			Uptime: 120,
			Generation: 2,
			Notes: '',
			Ips: ['fe80::1', '2001:db8::5', '10.0.0.5'],
			ComPort: '\\\\.\\pipe\\web'
		});
		expect(vm).toMatchObject({ state: 'running', memoryMB: 3000, consoles: ['serial'], uptimeSeconds: 120 });
		expect(vm.ipAddresses).toEqual(['10.0.0.5', '2001:db8::5']);
	});

	it('uses startup memory and no serial console when off without COM port', () => {
		const vm = toVmInfo({
			Id: 'x',
			Name: 'db',
			State: 'Off',
			Cpus: 2,
			MemoryMB: 0,
			StartupMB: 2048,
			Uptime: 0,
			Generation: 1,
			Notes: 'note',
			Ips: null,
			ComPort: ''
		});
		expect(vm).toMatchObject({ state: 'stopped', memoryMB: 2048, consoles: [], description: 'note', ipAddresses: [] });
	});
});

describe('PowerShell command framing', () => {
	it('keeps parameters out of the script text', () => {
		const command = buildCommand(7, 'Get-VM -Id $p.id', { id: "'; Remove-Item C:\\ -Recurse; '" });
		expect(command).not.toContain('Remove-Item');
		expect(command.endsWith('\n')).toBe(true);
		expect(command.split('\n')).toHaveLength(2);
		expect(command).toContain("'<<VMM:7:OK:'");
	});
});
