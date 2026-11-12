import { describe, expect, it } from 'vitest';
import { activeForwards, checkHmp, forwardsMetadata, hostfwdKey, hostfwdRule, normalizeForward, parseForwardsMetadata, userNetdev } from '../src/forwards';

// Real HMP output of QEMU 11.1 under libvirt 12.9 (macOS, qemu:///session).
const INFO_NETWORK = `net0: index=0,type=nic,model=virtio-net-pci,macaddr=52:54:00:f2:06:da
 \\ hostnet0: index=0,type=user,net=10.0.2.0,restrict=off
`;
const INFO_USERNET = `Hub -1 (hostnet0):
  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ
  TCP[HOST_FORWARD] 198       127.0.0.1  2299       10.0.2.15    22     0     0
  UDP[HOST_FORWARD]  12               *  5353       10.0.2.15  5353     0     0
  UDP[176 sec]      197       10.0.2.15 54635   86.80.166.233   123     0     0
`;

describe('libvirt port forwards', () => {
	it('round-trips through the domain metadata (as virsh returns it, with a namespace prefix)', () => {
		const forwards = [{ protocol: 'tcp' as const, hostAddress: '127.0.0.1', hostPort: 2222, guestPort: 22 }, { protocol: 'udp' as const, hostAddress: '0.0.0.0', hostPort: 5353, guestPort: 53 }];
		expect(parseForwardsMetadata(forwardsMetadata(forwards))).toEqual(forwards);
		const fromVirsh = `<vmm:forwards xmlns:vmm="https://sourceregistry.dev/vm-manager/forwards"><vmm:forward protocol="tcp" hostAddress="127.0.0.1" hostPort="2222" guestPort="22"/></vmm:forwards>`;
		expect(parseForwardsMetadata(fromVirsh)).toEqual([forwards[0]]);
		expect(parseForwardsMetadata('')).toEqual([]);
		expect(parseForwardsMetadata(`<forwards><forward protocol='sctp' hostPort='1' guestPort='2'/><forward protocol='tcp' hostPort='0' guestPort='22'/></forwards>`)).toEqual([]);
	});
	it('reads the user netdev and the active forwards from the monitor', () => {
		expect(userNetdev(INFO_NETWORK)).toBe('hostnet0');
		expect(userNetdev('net0: index=0,type=nic\n \\ hostnet0: index=0,type=tap,ifname=vnet0\n')).toBeUndefined();
		expect(activeForwards(INFO_USERNET)).toEqual([
			{ protocol: 'tcp', hostAddress: '127.0.0.1', hostPort: 2299, guestPort: 22 },
			{ protocol: 'udp', hostAddress: '0.0.0.0', hostPort: 5353, guestPort: 5353 }
		]);
	});
	it('builds hostfwd rules and refuses input that could reach the monitor unchecked', () => {
		const f = normalizeForward({ protocol: 'tcp', hostPort: 2222, guestPort: 22 });
		expect(f.hostAddress).toBe('127.0.0.1');
		expect(hostfwdRule(f)).toBe('tcp:127.0.0.1:2222-:22');
		expect(hostfwdKey(f)).toBe('tcp:127.0.0.1:2222');
		for (const bad of [{ hostPort: 0 }, { hostPort: 70000 }, { guestPort: 1.5 }, { hostAddress: '1.2.3.4 ; quit' }, { hostAddress: 'localhost' }, { protocol: 'icmp' }]) {
			expect(() => normalizeForward({ protocol: 'tcp', hostPort: 2222, guestPort: 22, ...bad } as never)).toThrow();
		}
	});
	it('treats HMP error text as an error', () => {
		expect(() => checkHmp("Could not set up host forwarding rule 'tcp:127.0.0.1:2222-:22'", 'x')).toThrow(/Could not set up/);
		expect(checkHmp('', 'x')).toBe('');
		expect(checkHmp('host forwarding rule for tcp:127.0.0.1:2299 removed\n', 'x')).toContain('removed');
	});
});
