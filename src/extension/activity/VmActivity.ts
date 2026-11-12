/**
 * What happened to each machine while VS Code ran: power actions asked for from here, state changes the refreshes
 * saw (also those from outside VS Code), guest commands, snapshots… One read-only document per machine
 * (**VM: Show Log**), with the hypervisor's own log for it underneath when the provider can read it.
 * Also raises the state-change notifications (`vmm.notifications.stateChanges`) and the one-time notice that a
 * machine runs emulated.
 */
import * as vscode from 'vscode';
import type { PowerAction } from '@vmm/sdk';
import type { VmRef } from '../../shared/protocol';
import type { ConnectionManager, VmPowerEvent, VmStateChanged } from '../clusters/ConnectionManager';
import { appendEntry, formatLogDocument, tail, type ActivityEntry, type ActivityLevel } from '../../shared/activity';
import { describeChange, shouldNotify, type NotifyMode } from '../../shared/stateChanges';
import { errorMessage, scopedLogger } from '../util/log';

const SCHEME = 'vmm-log';
const EMULATION_NOTICE_KEY = 'vmm.notice.emulation';

const ASKED: Record<PowerAction, string> = { start: 'Start', shutdown: 'Shut down', reboot: 'Reboot', stop: 'Power off', reset: 'Reset' };
const DONE: Record<PowerAction, string> = { start: 'Started', shutdown: 'Shut down', reboot: 'Rebooted', stop: 'Powered off', reset: 'Reset' };

const keyOf = (ref: VmRef) => `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;

export class VmActivity implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly entries = new Map<string, ActivityEntry[]>();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly pending = new Map<string, NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
	private readonly log = scopedLogger('vm');

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly manager: ConnectionManager
	) {
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
			manager.onDidPower((e) => this.onPower(e)),
			manager.onDidChangeVmState((changes) => changes.forEach((c) => this.onStateChange(c))),
			manager.onDidRemoveVms((gone) => {
				for (const vm of gone) this.record(vm.ref, vm.expected ? 'No longer listed' : 'Disappeared: no longer listed by the hypervisor', vm.expected ? 'info' : 'warn');
			})
		);
	}

	/** Adds a line to the machine's log (and to the *VM Manager* output channel). */
	record(ref: VmRef, text: string, level: ActivityLevel = 'info'): void {
		const key = keyOf(ref);
		const list = this.entries.get(key) ?? [];
		appendEntry(list, { at: Date.now(), level, text });
		this.entries.set(key, list);
		const name = this.manager.findVm(ref)?.vm.name ?? ref.vmId;
		this.log[level](`${name}: ${text.split('\n')[0]}`);
		this.scheduleUpdate(ref);
	}

	/** Opens the machine's log. */
	async show(ref: VmRef): Promise<void> {
		const document = await vscode.workspace.openTextDocument(this.uri(ref));
		await vscode.window.showTextDocument(document, { preview: false });
		// A virtual document has no language by default; the log grammar colours timestamps and levels.
		if (document.languageId !== 'log') await vscode.languages.setTextDocumentLanguage(document, 'log').then(undefined, () => undefined);
	}

	private uri(ref: VmRef): vscode.Uri {
		const name = (this.manager.findVm(ref)?.vm.name ?? ref.vmId).replace(/[\\/:*?"<>|]/g, '_');
		return vscode.Uri.from({ scheme: SCHEME, path: `/${name}.log`, query: new URLSearchParams(ref as unknown as Record<string, string>).toString() });
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const params = new URLSearchParams(uri.query);
		const ref: VmRef = { clusterId: params.get('clusterId') ?? '', nodeId: params.get('nodeId') ?? '', vmId: params.get('vmId') ?? '' };
		const location = this.manager.findVm(ref);
		const doc = {
			name: location?.vm.name ?? ref.vmId,
			where: location ? `${location.cluster.cluster.name} › ${location.node.name}` : 'no longer listed',
			entries: this.entries.get(keyOf(ref)) ?? []
		};
		const connection = location?.cluster.connection;
		if (!connection?.readVmLog) return formatLogDocument(doc);
		try {
			const text = await connection.readVmLog(ref.nodeId, ref.vmId);
			return formatLogDocument({ ...doc, hypervisorLog: text === undefined ? undefined : tail(text), hypervisorLogNote: text === undefined ? 'Not available for this machine from here.' : undefined });
		} catch (error) {
			return formatLogDocument({ ...doc, hypervisorLogNote: `Could not read it: ${errorMessage(error)}` });
		}
	}

	/** At most one refresh of an open log a second (reading the hypervisor log may go over SSH). */
	private scheduleUpdate(ref: VmRef): void {
		const key = keyOf(ref);
		if (this.pending.has(key)) return;
		this.pending.set(
			key,
			setTimeout(() => {
				this.pending.delete(key);
				const uri = this.uri(ref).toString();
				const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === SCHEME && d.uri.toString() === uri);
				if (open) this.changeEmitter.fire(open.uri);
			}, 1000)
		);
	}

	private onPower(e: VmPowerEvent): void {
		if (e.phase === 'requested') this.record(e.ref, `${ASKED[e.action]} requested from VS Code`);
		else if (e.phase === 'done') {
			this.record(e.ref, DONE[e.action]);
			if (e.action === 'start') void this.emulationNotice(e.ref);
		} else this.record(e.ref, `${ASKED[e.action]} failed: ${errorMessage(e.error)}`, (e.error as { code?: unknown })?.code === 'timeout' ? 'warn' : 'error');
	}

	private onStateChange(change: VmStateChanged): void {
		const text = describeChange(change, change.cause);
		this.record(change.ref, `${text} (was ${change.from})`, change.cause === 'outside' && change.to === 'stopped' ? 'warn' : 'info');
		const mode = vscode.workspace.getConfiguration('vmm').get<NotifyMode>('notifications.stateChanges', 'outside');
		if (!shouldNotify(mode, change.cause)) return;
		void vscode.window.showInformationMessage(text, 'Show Log').then((choice) => {
			if (choice === 'Show Log') void this.show(change.ref);
		});
	}

	/** Once ever: an emulated machine is much slower than it needs to be, and people should know why. */
	private async emulationNotice(ref: VmRef): Promise<void> {
		const location = this.manager.findVm(ref);
		if (!location?.vm.emulated || this.context.globalState.get<boolean>(EMULATION_NOTICE_KEY)) return;
		await this.context.globalState.update(EMULATION_NOTICE_KEY, true);
		this.record(ref, 'Runs in software emulation (slow)', 'warn');
		await vscode.window.showInformationMessage(
			`${location.vm.name} runs in software emulation, typically 10 to 50 times slower than a machine built for this computer's processor. A guest of the host's own architecture (an ARM64 image on Apple Silicon, x86-64 on a PC) runs at full speed.`,
			'OK'
		);
	}

	dispose(): void {
		for (const timer of this.pending.values()) clearTimeout(timer);
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
