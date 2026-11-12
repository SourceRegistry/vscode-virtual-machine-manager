import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockStats, memoryMB, netStats, parseDomain, parseDomifaddr, parseDomstats, parseNodeinfo, parseSnapshot, parseVersion, parseVncDisplay, stateOf, toDiskDevices, toNicDevices } from '../src/parse';
import { parseXml } from '../src/xml';
import { parseEtime, parseProcesses } from '../src/process';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('xml', () => {
	it('reads elements, attributes, text, entities and CDATA', () => {
		const root = parseXml(`<?xml version="1.0"?><!-- c --><a x='1' y="a&amp;b"><b>t &lt; u</b><c/><d><![CDATA[<raw>]]></d></a>`);
		expect(root.attrs).toEqual({ x: '1', y: 'a&b' });
		expect(root.children.map((c) => c.name)).toEqual(['b', 'c', 'd']);
		expect(root.children[0]!.text).toBe('t < u');
		expect(root.children[2]!.text).toBe('<raw>');
	});
	it('rejects broken input', () => {
		expect(() => parseXml('<a><b></a>')).toThrow();
		expect(() => parseXml('<a>')).toThrow();
		expect(() => parseXml('')).toThrow();
	});
});

describe('domain XML from real libvirt output', () => {
	const domain = parseDomain(fixture('dumpxml.xml'));
	it('reads identity and size', () => {
		expect(domain).toMatchObject({ name: 'lvprobe', vcpus: 2, memoryMB: 1024, arch: 'aarch64', agent: false });
		expect(domain.uuid).toMatch(/^[0-9a-f-]{36}$/);
	});
	it('reads the disk with its own source, not the backing file', () => {
		const disk = domain.disks.find((d) => d.target === 'vda')!;
		expect(disk).toMatchObject({ device: 'disk', bus: 'virtio', format: 'qcow2', readOnly: false });
		expect(disk.path).toMatch(/ov\.qcow2$/);
	});
	it('reads an empty CD drive', () => {
		expect(domain.disks.find((d) => d.target === 'sda')).toMatchObject({ device: 'cdrom', readOnly: true, path: undefined });
	});
	it('reads network, display and serial', () => {
		expect(domain.nics).toEqual([expect.objectContaining({ type: 'user', model: 'virtio', network: 'user', mac: expect.stringMatching(/^52:54:00:/) })]);
		expect(domain.graphics[0]).toMatchObject({ type: 'vnc', listen: '127.0.0.1' });
		expect(domain.serial).toEqual({ kind: 'pty', path: '/dev/ttys003' });
	});
	it('offers a pty serial port before it has a path (stopped domain)', () => {
		expect(parseDomain("<domain><name>x</name><uuid>u</uuid><devices><serial type='pty'/></devices></domain>").serial).toEqual({ kind: 'pty' });
	});
	it('reads how the domain runs: accelerated, or emulated (type qemu)', () => {
		expect(parseDomain(fixture('dumpxml.xml')).virtType).toBe('hvf');
		expect(parseDomain("<domain type='qemu'><name>x</name><uuid>u</uuid><devices/></domain>").virtType).toBe('qemu');
	});
	it('maps to SDK devices', () => {
		const disks = toDiskDevices(domain, new Map([['vda', 4294967296]]));
		expect(disks[0]).toMatchObject({ id: 'vda', kind: 'disk', sizeBytes: 4294967296, format: 'qcow2', removable: false });
		expect(disks[1]).toMatchObject({ id: 'sda', kind: 'cdrom', removable: true });
		expect(disks[1]).not.toHaveProperty('path');
		const nics = toNicDevices(domain, new Map([[domain.nics[0]!.mac!, ['10.0.2.15']]]));
		expect(nics[0]).toMatchObject({ ipAddresses: ['10.0.2.15'], reachable: false });
	});
	it('reads units', () => {
		expect(memoryMB(parseXml("<memory unit='GiB'>2</memory>"))).toBe(2048);
		expect(memoryMB(parseXml('<memory>1048576</memory>'))).toBe(1024);
		expect(memoryMB(parseXml("<memory unit='MB'>1000</memory>"))).toBe(954);
	});
	it('finds a guest agent channel, a tcp serial and a vnc socket', () => {
		const d = parseDomain(`<domain><name>x</name><uuid>u</uuid><devices><channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel><serial type='tcp'><source mode='bind' host='0.0.0.0' service='4555'/></serial><graphics type='vnc' socket='/run/x.sock'/></devices></domain>`);
		expect(d.agent).toBe(true);
		expect(d.serial).toEqual({ kind: 'tcp', host: '0.0.0.0', port: 4555 });
		expect(d.graphics[0]).toMatchObject({ socket: '/run/x.sock' });
	});
});

describe('virsh output', () => {
	const stats = parseDomstats(fixture('domstats.txt')).get('lvprobe')!;
	it('reads domstats', () => {
		expect(stateOf(stats)).toBe('running');
		expect(blockStats(stats)).toMatchObject([{ name: 'vda', readBytes: 142197760, writeOps: 384, capacity: 4294967296 }, { name: 'sda', readBytes: 0 }]);
		expect(netStats(stats)).toBeUndefined();
	});
	it('maps states', () => {
		expect(stateOf({ 'state.state': '5', 'state.reason': '5' })).toBe('saved');
		expect(stateOf({ 'state.state': '5', 'state.reason': '1' })).toBe('stopped');
		expect(stateOf({ 'state.state': '3' })).toBe('paused');
		expect(stateOf({ 'state.state': '4' })).toBe('stopping');
		expect(stateOf({ 'state.state': '6' })).toBe('unknown');
	});
	it('sums network counters', () => {
		expect(netStats({ 'net.count': '2', 'net.0.rx.bytes': '10', 'net.0.tx.bytes': '5', 'net.1.rx.bytes': '1', 'net.1.tx.bytes': '2' })).toEqual({ rxBytes: 11, txBytes: 7 });
	});
	it('reads two domains', () => {
		expect([...parseDomstats("Domain: 'a'\n  state.state=1\n\nDomain: 'b c'\n  state.state=5\n")].map(([n]) => n)).toEqual(['a', 'b c']);
		expect(parseDomstats('').size).toBe(0);
	});
	it('reads version and node info', () => {
		expect(parseVersion(fixture('version.txt'))).toMatchObject({ library: '12.9.0', hypervisor: expect.stringMatching(/^QEMU /) });
		expect(parseNodeinfo('CPU model:           aarch64\nCPU(s):              8\nMemory size:         16777216 KiB\n')).toEqual({ cpus: 8, memoryMB: 16384, model: 'aarch64' });
	});
	it('reads addresses and vnc displays', () => {
		expect(parseDomifaddr(' Name       MAC address          Protocol     Address\n-----\n vnet0      52:54:00:AA:BB:CC    ipv4         192.168.122.5/24\n -          52:54:00:AA:BB:CC    ipv6         fe80::1/64\n')).toEqual([{ mac: '52:54:00:aa:bb:cc', address: '192.168.122.5' }, { mac: '52:54:00:aa:bb:cc', address: 'fe80::1' }]);
		expect(parseVncDisplay('127.0.0.1:0\n')).toEqual({ host: '127.0.0.1', port: 5900 });
		expect(parseVncDisplay(':3')).toEqual({ host: '127.0.0.1', port: 5903 });
		expect(parseVncDisplay('')).toBeUndefined();
	});
	it('reads a snapshot', () => {
		expect(parseSnapshot('<domainsnapshot><name>s1</name><state>running</state><creationTime>1700000000</creationTime></domainsnapshot>')).toEqual({ id: 's1', name: 's1', createdAt: 1700000000000, includesMemory: true });
		expect(parseSnapshot('<domainsnapshot><name>s2</name><state>shutoff</state></domainsnapshot>')).toEqual({ id: 's2', name: 's2', includesMemory: false });
		expect(parseSnapshot("<domainsnapshot><name>s3</name><state>running</state><memory snapshot='no'/></domainsnapshot>").includesMemory).toBe(false);
	});
});

describe('qemu processes', () => {
	it('parses etime', () => {
		expect(parseEtime('01:05')).toBe(65);
		expect(parseEtime('2:03:04')).toBe(7384);
		expect(parseEtime('1-00:00:10')).toBe(86410);
		expect(parseEtime('x')).toBeUndefined();
	});
	it('finds libvirt guests by their -name', () => {
		const out = ' 60416  54.1 494992 01:23 /opt/homebrew/bin/qemu-system-aarch64 -name guest=lvprobe,debug-threads=on -S\n 100  1.0 10 00:01 /usr/bin/qemu-system-x86_64 -name plain -m 512\n 7 0.0 1 00:01 /bin/sleep 10\n';
		const found = parseProcesses(out);
		expect(found.get('lvprobe')).toEqual({ pid: 60416, cpuPercent: 54.1, rssMB: 483, uptimeSeconds: 83 });
		expect(found.get('plain')?.pid).toBe(100);
		expect(found.size).toBe(2);
	});
});
