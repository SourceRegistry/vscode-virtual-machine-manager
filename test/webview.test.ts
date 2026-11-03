// @vitest-environment happy-dom
/**
 * Renders the built webview bundle (dist/webview/main.js) in a DOM with a fake VS Code host and
 * checks that the client-lib based views render with the SvelteKit shims. Run `npm run build:webview`
 * first.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClusterSnapshot, HostToWebview, WebviewToHost } from '../src/shared/protocol';

const bundle = path.resolve(__dirname, '../dist/webview/main.js');

const snapshot: ClusterSnapshot[] = [
	{
		id: 'c1',
		name: 'Local (Hyper-V)',
		providerId: 'hyperv',
		providerName: 'Hyper-V',
		status: 'connected',
		capabilities: { create: true, edit: true, delete: true, power: ['start', 'shutdown', 'reboot', 'stop'], consoles: ['serial'], preview: true, external: true },
		nodes: [
			{
				id: 'local',
				name: 'DESKTOP-ALEX',
				status: 'online',
				cpus: 20,
				memoryMB: 32768,
				memoryUsedMB: 16000,
				vms: [
					{ id: 'v1', name: 'web-01', state: 'running', cpus: 4, memoryMB: 4096, uptimeSeconds: 3600, ipAddresses: ['10.0.0.5'] },
					{ id: 'v2', name: 'db-01', state: 'stopped', cpus: 2, memoryMB: 2048 }
				]
			}
		]
	}
];

const sent: WebviewToHost[] = [];

async function boot(view: string): Promise<void> {
	document.body.innerHTML = `<div id="app"></div><script id="vmm-boot" type="application/json">${JSON.stringify({ view, title: 't', vmName: 'web-01', ref: { clusterId: 'c1', nodeId: 'local', vmId: 'v1' } })}</script>`;
	document.body.className = 'vscode-dark';
	const reply = (message: HostToWebview) => window.dispatchEvent(new MessageEvent('message', { data: message }));
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		getState: () => undefined,
		setState: () => undefined,
		postMessage: (message: WebviewToHost) => {
			sent.push(message);
			if (message.kind !== 'request') return;
			const result =
				message.method === 'snapshot'
					? snapshot
					: message.method === 'getConfig'
						? {
								schema: [
									{ key: 'name', label: 'Name', type: 'text', required: true, group: 'General' },
									{ key: 'cpus', label: 'Processors', type: 'number', unit: 'cores', group: 'Hardware' },
									{ key: 'switch', label: 'Switch', type: 'select', options: [{ value: 'Default Switch', label: 'Default Switch' }], group: 'Network' },
									{ key: 'serial', label: 'Serial console', type: 'checkbox', group: 'Console' }
								],
								values: { name: 'web-01', cpus: 4, switch: 'Default Switch', serial: true },
								vm: snapshot[0].nodes[0].vms[0]
							}
						: undefined;
			setTimeout(() => reply({ kind: 'response', id: message.id, ok: true, result }));
		}
	});
	vi.resetModules();
	await import(/* @vite-ignore */ `${pathToFileURL(bundle).href}?view=${view}`);
	await new Promise((r) => setTimeout(r, 50));
}

describe.skipIf(!existsSync(bundle))('webview bundle', () => {
	beforeAll(() => {
		// APIs happy-dom lacks.
		(HTMLElement.prototype as unknown as Record<string, unknown>).showPopover ??= function () {};
		(HTMLElement.prototype as unknown as Record<string, unknown>).hidePopover ??= function () {};
		// The tests import the bundle once per view into the same DOM; a webview loads it once.
		const define = customElements.define.bind(customElements);
		customElements.define = (name, constructor, options) => {
			if (!customElements.get(name)) define(name, constructor, options);
		};
	});

	it('renders the overview from the host snapshot', async () => {
		await boot('overview');
		const text = document.body.textContent ?? '';
		expect(text).toContain('Virtual Machines');
		expect(text).toContain('Local (Hyper-V)');
		expect(text).toContain('DESKTOP-ALEX');
		expect(text).toContain('web-01');
		expect(text).toContain('db-01');
		expect(text).toContain('1 of 2 virtual machines running');
		expect(document.documentElement.dataset.theme).toBe('dark');
	});

	it('exposes native context-menu data on VM rows, nodes and clusters', async () => {
		await boot('overview');
		const marker = document.querySelector('[data-row-context]') as HTMLElement;
		marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
		const row = marker.closest('tr') as HTMLElement;
		const context = JSON.parse(row.getAttribute('data-vscode-context') ?? '{}');
		expect(context).toMatchObject({
			vmmItem: 'vm;state=running;start;shutdown;reboot;stop;graphical;serial;external;edit;delete;',
			clusterId: 'c1',
			nodeId: 'local',
			vmId: 'v1',
			preventDefaultContextMenuItems: true
		});
		const ancestors = [...document.querySelectorAll('[data-vscode-context]')].map((el) => JSON.parse(el.getAttribute('data-vscode-context')!).vmmItem);
		expect(ancestors).toContain('cluster;status=connected;');
		expect(ancestors).toContain('node;status=online;create;');
	});

	it('renders the VM settings form grouped by section', async () => {
		await boot('vmSettings');
		const text = document.body.textContent ?? '';
		expect(text).toContain('Hardware');
		expect(text).toContain('Network');
		expect((document.querySelector('input[name="name"]') as HTMLInputElement | null)?.value).toBe('web-01');
		expect(document.querySelector('select[name="switch"]')).not.toBeNull();
	});

	it('mounts the RDP console and relays its WebSocket over postMessage', async () => {
		sent.length = 0;
		await boot('console.rdp');
		expect(document.querySelector('iron-remote-desktop')).not.toBeNull();
		expect(sent.some((m) => m.kind === 'ready')).toBe(true);

		const reply = (message: HostToWebview) => window.dispatchEvent(new MessageEvent('message', { data: message }));
		const events: string[] = [];
		const socket = new WebSocket('wss://anything.invalid/');
		socket.binaryType = 'arraybuffer';
		socket.addEventListener('open', () => events.push('open'));
		socket.addEventListener('message', (e) => events.push(`message:${new Uint8Array((e as MessageEvent).data as ArrayBuffer).join(',')}`));
		// addEventListener only (what IronRDP uses): happy-dom, unlike Chromium, also invokes `on*`
		// properties of EventTarget subclasses during dispatch.
		socket.addEventListener('close', (e) => events.push(`close:${(e as CloseEvent).code}`));
		expect(sent.at(-1)).toEqual({ kind: 'console.socket', action: 'open' });

		reply({ kind: 'console.status', status: 'open' });
		reply({ kind: 'console.data', data: Uint8Array.of(1, 2, 3) });
		await new Promise((r) => setTimeout(r, 0));
		const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);
		socket.send(view);
		expect(sent.at(-1)).toEqual({ kind: 'console.input', data: Uint8Array.of(8, 7) });
		socket.close();
		expect(sent.at(-1)).toEqual({ kind: 'console.socket', action: 'close' });
		expect(events).toEqual(['open', 'message:1,2,3', 'close:1000']);
	});

	it('announces readiness from console views', async () => {
		sent.length = 0;
		await boot('console.preview');
		expect(sent.some((m) => m.kind === 'ready')).toBe(true);
		expect(document.body.textContent).toContain('Live preview');
	});
});
