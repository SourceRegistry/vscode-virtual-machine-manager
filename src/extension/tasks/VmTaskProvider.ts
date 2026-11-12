/**
 * The `vm` task type: start a machine and wait until SSH answers before a debug session, shut it down after, …
 * Tasks written in tasks.json run through `resolveTask`; *Run Task* also lists a Start and a Shut Down task for
 * every machine already listed.
 */
import * as vscode from 'vscode';
import type { PowerAction } from '@vmm/sdk';
import type { ConnectionManager } from '../clusters/ConnectionManager';
import type { VmControl } from '../api/VmControl';
import { TASK_TYPE, alreadyDone, checkDefinition, targetState, taskLabel, type VmTaskDefinition } from '../../shared/vmTask';
import { errorMessage } from '../util/log';

const SOURCE = 'VM Manager';

export class VmTaskProvider implements vscode.TaskProvider, vscode.Disposable {
	private readonly registration: vscode.Disposable;

	constructor(
		private readonly manager: ConnectionManager,
		private readonly control: VmControl
	) {
		this.registration = vscode.tasks.registerTaskProvider(TASK_TYPE, this);
	}

	/** Start and Shut Down for every machine already listed (never connects just to fill the list). */
	provideTasks(): vscode.Task[] {
		return this.manager.allVms().filter((l) => !l.vm.template).flatMap((l) =>
			(['start', 'shutdown'] as PowerAction[])
				.filter((action) => l.cluster.connection?.capabilities.power.includes(action))
				.map((action) => this.task({ type: TASK_TYPE, vm: `${l.cluster.cluster.name}/${l.vm.name}`, action }, vscode.TaskScope.Workspace, taskLabel(action, l.vm.name)))
		);
	}

	resolveTask(task: vscode.Task): vscode.Task | undefined {
		if (task.definition.type !== TASK_TYPE) return undefined;
		// The definition must stay the same object for VS Code to match the task in tasks.json.
		return this.task(task.definition as VmTaskDefinition, task.scope ?? vscode.TaskScope.Workspace, task.name, task.definition);
	}

	private task(definition: VmTaskDefinition, scope: vscode.TaskScope | vscode.WorkspaceFolder, name: string, original: vscode.TaskDefinition = definition): vscode.Task {
		const task = new vscode.Task(
			original,
			scope,
			name,
			SOURCE,
			new vscode.CustomExecution(async (resolved) => new VmTaskTerminal(this.control, { ...definition, ...resolved }))
		);
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
		task.detail = definition.waitFor === 'ssh' ? 'and wait until SSH answers' : undefined;
		return task;
	}

	dispose(): void {
		this.registration.dispose();
	}
}

/** Runs one task in the terminal panel: says what it does, ends with exit code 0 or 1. */
class VmTaskTerminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	readonly onDidWrite = this.writeEmitter.event;
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	readonly onDidClose = this.closeEmitter.event;
	private readonly cancel = { isCancellationRequested: false };

	constructor(
		private readonly control: VmControl,
		private readonly raw: Record<string, unknown>
	) {}

	private line(text: string): void {
		this.writeEmitter.fire(`${text.replace(/\n/g, '\r\n')}\r\n`);
	}

	open(): void {
		void this.run().then(
			() => this.closeEmitter.fire(0),
			(error) => {
				this.line(`\x1b[31m${errorMessage(error)}\x1b[0m`);
				this.closeEmitter.fire(1);
			}
		);
	}

	close(): void {
		this.cancel.isCancellationRequested = true;
	}

	private async run(): Promise<void> {
		const checked = checkDefinition(this.raw);
		if ('error' in checked) throw new Error(`Task "vm": ${checked.error}`);
		const { vm, action, waitFor, timeout } = checked.definition;
		const deadline = Date.now() + timeout * 1000;
		const left = () => Math.max(0, deadline - Date.now());
		const location = await this.control.resolve(vm);
		const name = location.vm.name;
		const where = `${location.cluster.cluster.name} › ${location.node.name}`;
		if (alreadyDone(action, location.vm.state)) {
			this.line(`${name} (${where}) is already ${location.vm.state === 'running' ? 'running' : 'off'}.`);
		} else {
			this.line(`${taskLabel(action, name)} (${where})…`);
			await this.control.power(vm, action);
		}
		if (waitFor === 'none') return;
		const state = targetState(action);
		await this.control.waitForState(vm, state, left(), this.cancel);
		this.line(`${name} is ${state === 'running' ? 'running' : 'off'}.`);
		if (waitFor === 'state') return;
		this.line(waitFor === 'ssh' ? 'Waiting for its SSH server…' : 'Waiting for an IP address…');
		const found = await this.control.address(vm, { ssh: waitFor === 'ssh', timeoutMs: left() }, this.cancel);
		if (!found) throw new Error(waitFor === 'ssh' ? `No SSH server answered on ${name} within ${timeout} s. Is sshd running, and is there a port forward to 22 or an address this computer reaches?` : `${name} reported no IP address within ${timeout} s (that needs the guest agent, or a DHCP lease the hypervisor knows).`);
		this.line(found.port ? `SSH answers on ${found.host}:${found.port}.` : `Address: ${found.host}.`);
	}
}
