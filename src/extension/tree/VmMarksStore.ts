/**
 * Favorites and the user's own groups of machines, kept by the core in global state (so they follow the user
 * into every window). The hypervisor never sees them. A group exists until it is deleted, also while empty.
 */
import * as vscode from 'vscode';
import type { VmRef } from '../../shared/protocol';
import { cleanName, groupNameProblem, sameName, uniqueNames, type VmMarks } from '../../shared/treeGroups';

const KEY = 'vmm.marks';

interface Stored {
	/** The groups, in the order they were made. */
	groups: string[];
	vms: Record<string, VmMarks>;
}

const keyOf = (ref: VmRef) => `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;

export class VmMarksStore implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	constructor(private readonly state: vscode.Memento) {
		void this.updateContext();
	}

	private read(): Stored {
		const stored = this.state.get<Partial<Stored>>(KEY);
		return { groups: [...(stored?.groups ?? [])], vms: { ...(stored?.vms ?? {}) } };
	}

	get(ref: VmRef): VmMarks {
		return this.read().vms[keyOf(ref)] ?? {};
	}

	isFavorite(ref: VmRef): boolean {
		return !!this.get(ref).favorite;
	}

	groupsOf(ref: VmRef): string[] {
		return this.get(ref).groups ?? [];
	}

	/** The user's groups, in the order they were made. */
	groups(): string[] {
		return this.read().groups;
	}

	hasFavorites(): boolean {
		return Object.values(this.read().vms).some((m) => m.favorite);
	}

	/** Whether the Groups view has anything to show. */
	hasGroups(): boolean {
		return this.hasFavorites() || this.groups().length > 0;
	}

	async setFavorite(refs: readonly VmRef[], favorite: boolean): Promise<void> {
		await this.change((s) => this.update(s, refs, (m) => ({ ...m, favorite: favorite || undefined })));
	}

	/** Makes a group (empty until machines are added). Throws with the reason for a bad name. */
	async createGroup(name: string): Promise<string> {
		const clean = cleanName(name);
		const problem = groupNameProblem(clean, this.groups());
		if (problem) throw new Error(problem);
		await this.change((s) => s.groups.push(clean));
		return clean;
	}

	async renameGroup(from: string, to: string): Promise<void> {
		const clean = cleanName(to);
		const problem = groupNameProblem(clean, this.groups(), from);
		if (problem) throw new Error(problem);
		await this.change((s) => {
			s.groups = s.groups.map((g) => (sameName(g, from) ? clean : g));
			for (const [key, marks] of Object.entries(s.vms)) {
				if (marks.groups) s.vms[key] = { ...marks, groups: uniqueNames(marks.groups.map((g) => (sameName(g, from) ? clean : g))) };
			}
		});
	}

	/** Removes the group; its machines stay as they are. */
	async deleteGroup(name: string): Promise<void> {
		await this.change((s) => {
			s.groups = s.groups.filter((g) => !sameName(g, name));
			for (const [key, marks] of Object.entries(s.vms)) {
				if (marks.groups) s.vms[key] = { ...marks, groups: marks.groups.filter((g) => !sameName(g, name)) };
			}
		});
	}

	async addToGroup(refs: readonly VmRef[], name: string): Promise<void> {
		await this.change((s) => {
			if (!s.groups.some((g) => sameName(g, name))) s.groups.push(cleanName(name));
			const label = s.groups.find((g) => sameName(g, name))!;
			this.update(s, refs, (m) => ({ ...m, groups: uniqueNames([...(m.groups ?? []), label]) }));
		});
	}

	async removeFromGroup(refs: readonly VmRef[], name: string): Promise<void> {
		await this.change((s) => this.update(s, refs, (m) => ({ ...m, groups: (m.groups ?? []).filter((g) => !sameName(g, name)) })));
	}

	/** A deleted machine takes its marks with it; its groups stay. */
	async forget(ref: VmRef): Promise<void> {
		if (!(keyOf(ref) in this.read().vms)) return;
		await this.change((s) => {
			delete s.vms[keyOf(ref)];
		});
	}

	private update(s: Stored, refs: readonly VmRef[], change: (marks: VmMarks) => VmMarks): void {
		for (const ref of refs) {
			const next = change(s.vms[keyOf(ref)] ?? {});
			const clean: VmMarks = { ...(next.favorite ? { favorite: true } : {}), ...(next.groups?.length ? { groups: next.groups } : {}) };
			if (clean.favorite || clean.groups) s.vms[keyOf(ref)] = clean;
			else delete s.vms[keyOf(ref)];
		}
	}

	private async change(apply: (stored: Stored) => void): Promise<void> {
		const stored = this.read();
		apply(stored);
		await this.state.update(KEY, stored);
		await this.updateContext();
		this.emitter.fire();
	}

	private async updateContext(): Promise<void> {
		// Shows the Groups view under the main one.
		await vscode.commands.executeCommand('setContext', 'vmm.hasGroups', this.hasGroups());
		await vscode.commands.executeCommand('setContext', 'vmm.hasUserGroups', this.groups().length > 0);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
