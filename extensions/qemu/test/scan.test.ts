import { describe, expect, it } from 'vitest';
import { findExternalVms, isQemuSystemBinary, parseMemory, parseMonitorAddress, parseOptionValue, parsePsList, parseQemuCommand, parseSerialAddress, parseVnc, parseVncEndpoint } from '../src/scan';

describe('parsePsList', () => {
	it('reads pid and command', () => {
		expect(parsePsList('  123 /usr/bin/qemu-system-x86_64 -m 1G\n 45 bash\n\n')).toEqual([
			{ pid: 123, command: '/usr/bin/qemu-system-x86_64 -m 1G' },
			{ pid: 45, command: 'bash' }
		]);
	});
});

describe('binary names', () => {
	it('accepts system emulators only', () => {
		expect(isQemuSystemBinary('/opt/homebrew/bin/qemu-system-aarch64')).toBe(true);
		expect(isQemuSystemBinary('C:\\qemu\\qemu-system-x86_64.exe')).toBe(true);
		expect(isQemuSystemBinary('/usr/bin/qemu-kvm')).toBe(true);
		expect(isQemuSystemBinary('/usr/bin/qemu-img')).toBe(false);
		expect(isQemuSystemBinary('/usr/bin/qemu-ga')).toBe(false);
	});
});

describe('option helpers', () => {
	it('splits head, options and escaped commas', () => {
		const v = parseOptionValue('socket,id=mon,path=/tmp/a,,b.sock,server=on');
		expect(v.head).toBe('socket');
		expect(v.options.get('path')).toBe('/tmp/a,b.sock');
		expect(v.options.get('server')).toBe('on');
	});
	it('parses memory sizes', () => {
		expect(parseMemory('2048')).toBe(2048);
		expect(parseMemory('4G')).toBe(4096);
		expect(parseMemory('size=512M,slots=2')).toBe(512);
		expect(parseMemory('x')).toBeUndefined();
	});
	it('parses monitor addresses', () => {
		expect(parseMonitorAddress('tcp:127.0.0.1:4444,server=on,wait=off')).toEqual({ host: '127.0.0.1', port: 4444 });
		expect(parseMonitorAddress('unix:/tmp/q.sock,server,nowait')).toEqual({ socket: '/tmp/q.sock' });
		expect(parseMonitorAddress('stdio')).toBeUndefined();
	});
	it('turns a VNC display into a port', () => {
		expect(parseVnc('127.0.0.1:0')).toBe(5900);
		expect(parseVnc(':3')).toBe(5903);
		expect(parseVnc('unix:/tmp/v.sock')).toBeUndefined();
		expect(parseVnc('none')).toBeUndefined();
	});
});

describe('parseQemuCommand', () => {
	it('reads what this extension itself starts', () => {
		const vm = parseQemuCommand({
			pid: 10,
			command:
				'/opt/homebrew/bin/qemu-system-x86_64 -name my-vm -machine q35 -accel tcg -smp 2 -m 2048 -drive file=/vms/a/disk0.qcow2,if=none,id=hd0,format=qcow2 -device ide-hd,drive=hd0 -drive file=/isos/x.iso,if=none,id=cd0,media=cdrom,readonly=on -nic user,model=e1000 -vnc 127.0.0.1:0 -qmp tcp:127.0.0.1:50000,server=on,wait=off'
		});
		expect(vm).toMatchObject({
			pid: 10,
			name: 'my-vm',
			cpus: 2,
			memoryMB: 2048,
			machine: 'q35',
			disks: ['/vms/a/disk0.qcow2'],
			cdrom: '/isos/x.iso',
			vncPort: 5900,
			qmp: { host: '127.0.0.1', port: 50000 }
		});
	});

	it('finds a unix monitor through -chardev and -mon', () => {
		const vm = parseQemuCommand({
			pid: 11,
			command: 'qemu-system-x86_64 -name guest=web,debug-threads=on -m size=1G -smp cpus=4,sockets=1 -chardev socket,id=charmonitor,path=/run/q/web.sock,server=on,wait=off -mon chardev=charmonitor,id=monitor,mode=control -hda /d/web.img'
		});
		expect(vm).toMatchObject({ name: 'web', memoryMB: 1024, cpus: 4, qmp: { socket: '/run/q/web.sock' }, disks: ['/d/web.img'] });
	});

	it('has no endpoint for inherited sockets (libvirt) or when there is no monitor', () => {
		expect(parseQemuCommand({ pid: 12, command: 'qemu-system-x86_64 -chardev socket,id=m,fd=30,server=on -mon chardev=m,mode=control' })?.qmp).toBeUndefined();
		expect(parseQemuCommand({ pid: 13, command: 'qemu-system-x86_64 -m 512 -hda /d/a.img' })?.qmp).toBeUndefined();
	});

	it('ignores firmware pflash drives, non-qemu processes and uses defaults', () => {
		const vm = parseQemuCommand({ pid: 14, command: 'qemu-system-aarch64 -drive if=pflash,format=raw,readonly=on,file=/fw/edk2.fd -drive file=/d/root.qcow2' });
		expect(vm?.disks).toEqual(['/d/root.qcow2']);
		expect(vm?.name).toBe('qemu-14');
		expect(parseQemuCommand({ pid: 15, command: 'vim qemu-system-x86_64.txt' })).toBeUndefined();
	});

	it('handles quoted paths with spaces', () => {
		expect(parseQemuCommand({ pid: 16, command: 'qemu-system-x86_64 -hda "/My VMs/a b.img"' })?.disks).toEqual(['/My VMs/a b.img']);
	});
});

describe('display and serial of a running QEMU', () => {
	const parse = (args: string) => parseQemuCommand({ pid: 20, command: `qemu-system-x86_64 ${args}` })!;

	it('reads VNC over TCP, a remote host and a unix socket', () => {
		expect(parseVncEndpoint('0.0.0.0:2')).toEqual({ port: 5902, host: undefined });
		expect(parseVncEndpoint('192.168.1.5:1,password=off')).toEqual({ port: 5901, host: '192.168.1.5' });
		expect(parseVncEndpoint('unix:/tmp/v.sock')).toEqual({ socket: '/tmp/v.sock' });
		expect(parseVncEndpoint('none')).toBeUndefined();
		expect(parse('-display vnc=:4')).toMatchObject({ vncPort: 5904 });
		expect(parse('-vnc unix:/run/vm.vnc')).toMatchObject({ vncSocket: '/run/vm.vnc' });
	});

	it('reads listening -serial sockets only', () => {
		expect(parseSerialAddress('tcp:127.0.0.1:4555,server=on,wait=off')).toEqual({ host: '127.0.0.1', port: 4555 });
		expect(parseSerialAddress('telnet::4556,server,nowait')).toEqual({ host: '127.0.0.1', port: 4556, telnet: true });
		expect(parseSerialAddress('mon:telnet:0.0.0.0:4557,server=on,wait=off')).toEqual({ host: '127.0.0.1', port: 4557, telnet: true });
		expect(parseSerialAddress('unix:/tmp/s.sock,server=on')).toEqual({ socket: '/tmp/s.sock' });
		expect(parseSerialAddress('tcp:10.0.0.1:4555')).toBeUndefined();
		expect(parseSerialAddress('stdio')).toBeUndefined();
		expect(parseSerialAddress('pty')).toBeUndefined();
	});

	it('follows -serial chardev: and serial devices to their chardev', () => {
		expect(parse('-chardev socket,id=s0,host=127.0.0.1,port=4600,server=on,wait=off,telnet=on -serial chardev:s0').serial).toEqual({
			host: '127.0.0.1',
			port: 4600,
			telnet: true
		});
		expect(parse('-chardev socket,id=c,path=/tmp/c.sock,server=on,wait=off -device isa-serial,chardev=c').serial).toEqual({ socket: '/tmp/c.sock' });
		expect(parse('-chardev socket,id=c,host=127.0.0.1,port=4601 -serial chardev:c').serial).toBeUndefined();
	});

	it('only the first serial port counts', () => {
		expect(parse('-serial mon:stdio -serial tcp::4602,server=on').serial).toBeUndefined();
		expect(parse('-serial none -serial tcp::4602,server=on').serial).toEqual({ host: '127.0.0.1', port: 4602 });
		expect(parse('-m 512').serial).toBeUndefined();
	});
});

describe('findExternalVms', () => {
	it('skips excluded pids and non-qemu processes', () => {
		const list = [
			{ pid: 1, command: 'launchd' },
			{ pid: 2, command: 'qemu-system-x86_64 -name managed' },
			{ pid: 3, command: 'qemu-system-x86_64 -name other' }
		];
		expect(findExternalVms(list, new Set([2])).map((v) => v.name)).toEqual(['other']);
	});
});
