import type { BootData, HostToWebview, RpcMethod, RpcMethods, WebviewToHost } from '../../../shared/protocol';

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi may only be called once per page.
const vscode: VsCodeApi = acquireVsCodeApi();

let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Set<(message: HostToWebview) => void>();

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
	const message = event.data;
	if (!message || typeof message !== 'object') return;
	if (message.kind === 'response') {
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		if (message.ok) entry.resolve(message.result);
		else entry.reject(new Error(message.error));
		return;
	}
	for (const listener of listeners) listener(message);
});

export function post(message: WebviewToHost): void {
	vscode.postMessage(message);
}

/**
 * RPC params are JSON data. Copy them so values taken from Svelte `$state` (proxies, which
 * `postMessage` cannot clone) can be passed as they are.
 */
function plain<T>(value: T): T {
	return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

type Params<M extends RpcMethod> = RpcMethods[M]['params'] extends void ? [] : [RpcMethods[M]['params']];

export function request<M extends RpcMethod>(method: M, ...params: Params<M>): Promise<RpcMethods[M]['result']> {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
		try {
			post({ kind: 'request', id, method, params: plain(params[0]) });
		} catch (error) {
			pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export function onMessage(listener: (message: HostToWebview) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getState<T>(): T | undefined {
	return vscode.getState() as T | undefined;
}

export function setState<T>(state: T): void {
	vscode.setState(state);
}

export function readBoot(): BootData {
	const element = document.getElementById('vmm-boot');
	return JSON.parse(element?.textContent ?? '{}') as BootData;
}
