import { describe, expect, it } from 'vitest';
import { toSnapshots } from '../src/snapshots';
import { isTemplate, TEMPLATE_MARKER, visibleNotes, withTemplate } from '../src/template';
import { toVmInfo } from '../src/HyperVProvider';
import * as scripts from '../src/scripts';

describe('Hyper-V snapshots', () => {
	it('lists oldest first and skips a missing creation time', () => {
		expect(toSnapshots([{ Id: 'b', Name: 'later', Created: 200 }, { Id: 'a', Name: 'first', Created: 100 }, { Id: 'c', Name: 'odd', Created: null }]))
			.toEqual([{ id: 'c', name: 'odd' }, { id: 'a', name: 'first', createdAt: 100 }, { id: 'b', name: 'later', createdAt: 200 }]);
	});
});

describe('Hyper-V templates (a marker in the notes)', () => {
	it('detects, hides and sets the marker', () => {
		expect(isTemplate(`${TEMPLATE_MARKER}\nbase image`)).toBe(true);
		expect(isTemplate('base image')).toBe(false);
		expect(isTemplate(null)).toBe(false);
		expect(visibleNotes(`${TEMPLATE_MARKER}\nbase image`)).toBe('base image');
		expect(visibleNotes(`${TEMPLATE_MARKER}\r\nbase image`)).toBe('base image');
		expect(visibleNotes(TEMPLATE_MARKER)).toBe('');
		expect(withTemplate('base image', true)).toBe(`${TEMPLATE_MARKER}\nbase image`);
		expect(withTemplate('', true)).toBe(TEMPLATE_MARKER);
		expect(withTemplate(withTemplate('x', true), true)).toBe(`${TEMPLATE_MARKER}\nx`);
		expect(withTemplate(`${TEMPLATE_MARKER}\nx`, false)).toBe('x');
	});
	it('shows a template as a template with clean notes', () => {
		const vm = toVmInfo({ Id: 'x', Name: 'base', State: 'Off', Cpus: 2, MemoryMB: 0, StartupMB: 2048, Uptime: 0, Generation: 2, Notes: `${TEMPLATE_MARKER}\nbase image`, Ips: null, ComPort: '' });
		expect(vm).toMatchObject({ template: true, description: 'base image' });
		expect(toVmInfo({ Id: 'y', Name: 'n', State: 'Off', Cpus: 1, MemoryMB: 0, StartupMB: 1, Uptime: 0, Generation: 2, Notes: '', Ips: null, ComPort: '' }).template).toBeUndefined();
	});
	it('keeps the script marker in step with the helper', () => {
		expect(scripts.POWER).toContain(`'${TEMPLATE_MARKER}'`);
		expect(scripts.CLONE_VM).toContain(`'${TEMPLATE_MARKER}'`);
		expect(TEMPLATE_MARKER.length).toBe(14);
	});
});
