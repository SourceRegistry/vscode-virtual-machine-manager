import { describe, expect, it } from 'vitest';
import { StateTracker, causeOf, describeChange, shouldNotify, type StateChange } from '../src/shared/stateChanges';
import { formatSeconds, operationText } from '../src/shared/countdown';
import { appendEntry, formatEntry, formatLogDocument, tail, type ActivityEntry } from '../src/shared/activity';
import { lookupVm, vmHandle } from '../src/shared/vmLookup';
import { allTags, groupVms, parseTags } from '../src/shared/treeGroups';

describe('state changes', () => {
	it('records the first listing, then reports settled changes only', () => {
		const t = new StateTracker();
		expect(t.update('c', [{ key: 'a', name: 'web', state: 'running' }])).toEqual([]);
		// Transitional states are skipped: running → stopping → stopped is one change.
		expect(t.update('c', [{ key: 'a', name: 'web', state: 'stopping' }])).toEqual([]);
		expect(t.update('c', [{ key: 'a', name: 'web', state: 'stopped' }])).toEqual([{ key: 'a', name: 'web', from: 'running', to: 'stopped' }]);
		expect(t.update('c', [{ key: 'a', name: 'web', state: 'stopped' }])).toEqual([]);
	});
	it('says nothing about new machines, gone ones, other clusters, or after a reset', () => {
		const t = new StateTracker();
		t.update('c', [{ key: 'a', name: 'web', state: 'running' }]);
		expect(t.update('c', [{ key: 'a', name: 'web', state: 'running' }, { key: 'b', name: 'db', state: 'stopped' }])).toEqual([]);
		expect(t.update('d', [{ key: 'a', name: 'web', state: 'stopped' }])).toEqual([]);
		expect(t.update('c', [])).toEqual([]);
		expect(t.update('c', [{ key: 'a', name: 'web', state: 'stopped' }])).toEqual([]);
		t.reset('c');
		expect(t.update('c', [{ key: 'a', name: 'web', state: 'running' }])).toEqual([]);
	});
	it('credits VS Code only for a recent request that leads to the new state', () => {
		const stopped: StateChange = { key: 'a', name: 'web', from: 'running', to: 'stopped' };
		const now = 1_000_000;
		expect(causeOf(stopped, { action: 'shutdown', at: now - 60_000 }, now)).toBe('vscode');
		expect(causeOf(stopped, { action: 'shutdown', at: now - 16 * 60_000 }, now)).toBe('outside');
		expect(causeOf(stopped, { action: 'start', at: now - 1000 }, now)).toBe('outside');
		expect(causeOf(stopped, undefined, now)).toBe('outside');
		expect(causeOf({ ...stopped, from: 'stopped', to: 'running' }, { action: 'start', at: now - 1000 }, now)).toBe('vscode');
	});
	it('words the change and decides on a notification', () => {
		expect(describeChange({ name: 'web', from: 'running', to: 'stopped' }, 'outside')).toBe('web stopped outside VS Code');
		expect(describeChange({ name: 'web', from: 'stopped', to: 'running' }, 'vscode')).toBe('web started');
		expect(describeChange({ name: 'web', from: 'paused', to: 'running' }, 'outside')).toBe('web resumed outside VS Code');
		expect(shouldNotify('outside', 'outside')).toBe(true);
		expect(shouldNotify('outside', 'vscode')).toBe(false);
		expect(shouldNotify('all', 'vscode')).toBe(true);
		expect(shouldNotify('off', 'outside')).toBe(false);
	});
});

describe('countdown', () => {
	it('counts down a graceful shutdown the provider waits for, then counts up', () => {
		expect(operationText('shutdown', 0, 7_000, 30)).toBe('Shutting down… 23 s left');
		expect(operationText('reboot', 0, 29_500, 30)).toBe('Rebooting… 1 s left');
		expect(operationText('shutdown', 0, 45_000, 30)).toBe('Shutting down… 45 s');
		expect(operationText('shutdown', 0, 12_000)).toBe('Shutting down… 12 s');
	});
	it('shows nothing for quick operations and elapsed time for slow ones', () => {
		expect(operationText('start', 0, 1_000, 30)).toBe('Starting…');
		expect(operationText('start', 0, 125_000, 30)).toBe('Starting… 2 min 05 s');
		expect(formatSeconds(59)).toBe('59 s');
	});
});

describe('activity log', () => {
	const at = new Date(2026, 10, 12, 9, 5, 7, 42).getTime();
	it('keeps the newest entries', () => {
		const entries: ActivityEntry[] = [];
		for (let i = 0; i < 5; i++) appendEntry(entries, { at, level: 'info', text: String(i) }, 3);
		expect(entries.map((e) => e.text)).toEqual(['2', '3', '4']);
	});
	it('formats entries and the document', () => {
		expect(formatEntry({ at, level: 'warn', text: 'one\ntwo' })).toBe('2026-11-12 09:05:07.042 [warn] one\n    two');
		const doc = formatLogDocument({ name: 'web', where: 'Lab › host', entries: [{ at, level: 'info', text: 'Start requested' }], hypervisorLog: 'qemu: boot\n' });
		expect(doc).toContain('# web (Lab › host)');
		expect(doc).toContain('[info] Start requested');
		expect(doc).toContain('# Hypervisor log\n\nqemu: boot\n');
		expect(formatLogDocument({ name: 'web', where: 'x', entries: [] })).toContain('(nothing yet)');
		expect(formatLogDocument({ name: 'web', where: 'x', entries: [], hypervisorLogNote: 'Not available over SSH.' })).toContain('Not available over SSH.');
	});
	it('keeps the end of a long hypervisor log, from a line start', () => {
		const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
		const cut = tail(text, 40);
		expect(cut.startsWith('[… earlier lines left out]\n')).toBe(true);
		expect(cut.endsWith('line 99')).toBe(true);
		expect(cut.split('\n')[1]).toMatch(/^line \d+$/);
		expect(tail('short', 40)).toBe('short');
	});
});

describe('finding a machine by name', () => {
	const vms = [
		{ clusterId: 'c1', clusterName: 'Lab', nodeId: 'n', vmId: 'v1', name: 'web' },
		{ clusterId: 'c2', clusterName: 'Home', nodeId: 'n', vmId: 'v2', name: 'web' },
		{ clusterId: 'c2', clusterName: 'Home', nodeId: 'n', vmId: 'v3', name: 'DB' }
	];
	it('by id, name (any case) or cluster/name', () => {
		expect(lookupVm(vms, vmHandle(vms[1]))).toEqual({ vm: vms[1] });
		expect(lookupVm(vms, 'db')).toEqual({ vm: vms[2] });
		expect(lookupVm(vms, 'home/web')).toEqual({ vm: vms[1] });
	});
	it('explains a missing or ambiguous name', () => {
		expect(lookupVm(vms, 'nope')).toEqual({ error: 'No virtual machine is called "nope".' });
		expect(lookupVm(vms, 'web')).toMatchObject({ error: expect.stringContaining('Lab/web, Home/web') });
		expect(lookupVm(vms, ' ')).toMatchObject({ error: expect.any(String) });
	});
	it('makes ids that survive odd characters', () => {
		expect(vmHandle({ clusterId: 'a/b', nodeId: 'n', vmId: 'x y' })).toBe('a%2Fb/n/x%20y');
	});
});

describe('favorites, tags and groups', () => {
	it('cleans up typed tags', () => {
		expect(parseTags(' web, Lab ,web,  ,WEB , two  words ')).toEqual(['web', 'Lab', 'two words']);
		expect(parseTags('x'.repeat(50))[0]).toHaveLength(40);
		expect(allTags([{ tags: ['b', 'a'] }, { tags: ['A'] }, {}])).toEqual(['a', 'b']);
	});
	it('groups by tag, with untagged last, a machine in each of its tags', () => {
		const groups = groupVms(
			[
				{ key: '1', name: 'web', state: 'running', tags: ['prod', 'web'] },
				{ key: '2', name: 'db', state: 'stopped', tags: ['Prod'] },
				{ key: '3', name: 'scratch', state: 'stopped' }
			],
			'tag'
		);
		expect(groups).toEqual([
			{ id: 'tag:prod', label: 'Prod', keys: ['2', '1'] },
			{ id: 'tag:web', label: 'web', keys: ['1'] },
			{ id: 'untagged', label: 'Untagged', keys: ['3'] }
		]);
	});
	it('groups by state, running first, empty groups left out', () => {
		const groups = groupVms(
			[
				{ key: '1', name: 'b', state: 'stopped' },
				{ key: '2', name: 'a', state: 'running' },
				{ key: '3', name: 'c', state: 'stopped' }
			],
			'state'
		);
		expect(groups.map((g) => [g.label, g.keys])).toEqual([['Running', ['2']], ['Off', ['1', '3']]]);
	});
});

import { alreadyDone, checkDefinition, taskLabel, targetState } from '../src/shared/vmTask';

describe('vm task definitions', () => {
	it('fills in defaults', () => {
		expect(checkDefinition({ type: 'vm', vm: ' web ', action: 'start' })).toEqual({ definition: { vm: 'web', action: 'start', waitFor: 'state', timeout: 300 } });
		expect(checkDefinition({ type: 'vm', vm: 'web', action: 'start', waitFor: 'ssh', timeout: 60 })).toMatchObject({ definition: { waitFor: 'ssh', timeout: 60 } });
	});
	it('explains what is wrong', () => {
		expect(checkDefinition({ type: 'vm', action: 'start' })).toMatchObject({ error: expect.stringContaining('"vm"') });
		expect(checkDefinition({ type: 'vm', vm: 'web', action: 'boot' })).toMatchObject({ error: expect.stringContaining('"action"') });
		expect(checkDefinition({ type: 'vm', vm: 'web', action: 'start', waitFor: 'coffee' })).toMatchObject({ error: expect.stringContaining('"waitFor"') });
		expect(checkDefinition({ type: 'vm', vm: 'web', action: 'shutdown', waitFor: 'ssh' })).toMatchObject({ error: expect.stringContaining('needs the machine running') });
		expect(checkDefinition({ type: 'vm', vm: 'web', action: 'start', timeout: -1 })).toMatchObject({ error: expect.stringContaining('"timeout"') });
	});
	it('knows where an action ends and when there is nothing to do', () => {
		expect(targetState('shutdown')).toBe('stopped');
		expect(targetState('reboot')).toBe('running');
		expect(alreadyDone('start', 'running')).toBe(true);
		expect(alreadyDone('start', 'paused')).toBe(false);
		expect(alreadyDone('shutdown', 'saved')).toBe(true);
		expect(alreadyDone('reboot', 'running')).toBe(false);
		expect(taskLabel('shutdown', 'web')).toBe('Shut Down web');
	});
});
