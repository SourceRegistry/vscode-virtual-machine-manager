import { describe, expect, it } from 'vitest';
import { VanishedVms } from '../src/shared/vanished';

const node = (nodeId: string, vmIds: string[], listed = true, adopted = false) => ({ nodeId, listed, vms: vmIds.map((id) => ({ id, name: `vm-${id}`, adopted })) });
const ref = (nodeId: string, vmId: string, clusterId = 'c') => ({ clusterId, nodeId, vmId });
const gone = (nodeId: string, vmId: string, clusterId = 'c', adopted = false) => ({ ref: ref(nodeId, vmId, clusterId), name: `vm-${vmId}`, adopted });

describe('VanishedVms', () => {
	it('concludes a VM is gone only after it was missing from two listings in a row', () => {
		const v = new VanishedVms();
		expect(v.update('c', [node('n', ['a', 'b'])])).toEqual([]);
		expect(v.update('c', [node('n', ['a'])])).toEqual([]); // first miss: not yet
		expect(v.update('c', [node('n', ['a'])])).toEqual([gone('n', 'b')]); // second miss
		expect(v.update('c', [node('n', ['a'])])).toEqual([]); // reported once
	});

	it('forgets a miss when the VM comes back, so one odd listing never closes anything', () => {
		const v = new VanishedVms();
		v.update('c', [node('n', ['a', 'b'])]);
		v.update('c', [node('n', ['a'])]);
		v.update('c', [node('n', ['a', 'b'])]); // back
		expect(v.update('c', [node('n', ['a'])])).toEqual([]); // counting starts again
	});

	it('says nothing about VMs it never saw', () => {
		const v = new VanishedVms();
		expect(v.update('c', [node('n', [])])).toEqual([]);
		expect(v.update('c', [node('n', [])])).toEqual([]);
	});

	it('ignores a node whose listing failed or that is offline', () => {
		const v = new VanishedVms();
		v.update('c', [node('n', ['a'])]);
		for (let i = 0; i < 5; i++) expect(v.update('c', [node('n', [], false)])).toEqual([]);
		// The node answers again with the VM: nothing was lost, and nothing was counted meanwhile.
		expect(v.update('c', [node('n', ['a'])])).toEqual([]);
		expect(v.update('c', [node('n', [])])).toEqual([]);
		expect(v.update('c', [node('n', [])])).toEqual([gone('n', 'a')]);
	});

	it('does not count a node that is missing from the refresh altogether', () => {
		const v = new VanishedVms();
		v.update('c', [node('n1', ['a']), node('n2', ['b'])]);
		expect(v.update('c', [node('n1', ['a'])])).toEqual([]);
		expect(v.update('c', [node('n1', ['a'])])).toEqual([]);
	});

	it('keeps clusters apart, including equal VM ids', () => {
		const v = new VanishedVms();
		v.update('c1', [node('n', ['100'])]);
		v.update('c2', [node('n', ['100'])]);
		v.update('c1', [node('n', [])]);
		expect(v.update('c1', [node('n', [])])).toEqual([gone('n', '100', 'c1')]);
		expect(v.update('c2', [node('n', ['100'])])).toEqual([]);
	});

	it('reports everything of a removed cluster at once, and forgets a reconfigured one silently', () => {
		const v = new VanishedVms();
		v.update('c', [node('n', ['a', 'b'])]);
		v.update('x', [node('n', ['z'])]);
		expect(v.removeCluster('c').map((g) => g.ref.vmId).sort()).toEqual(['a', 'b']);
		expect(v.removeCluster('c')).toEqual([]);

		v.reset('x');
		expect(v.update('x', [node('n', [])])).toEqual([]);
		expect(v.update('x', [node('n', [])])).toEqual([]);
	});

	it('remembers the name and whether the VM was attached, since it can no longer be looked up', () => {
		const v = new VanishedVms();
		v.update('c', [node('n', ['a'], true, true)]);
		v.update('c', [node('n', [])]);
		expect(v.update('c', [node('n', [])])).toEqual([gone('n', 'a', 'c', true)]);
	});

	it('does not report a VM the user deleted themselves', () => {
		const v = new VanishedVms();
		v.update('c', [node('n', ['a', 'b'])]);
		v.forget(ref('n', 'a'));
		v.update('c', [node('n', ['b'])]);
		expect(v.update('c', [node('n', ['b'])])).toEqual([]);
	});
});
