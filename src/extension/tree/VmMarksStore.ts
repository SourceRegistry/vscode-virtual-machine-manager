/**
 * Favorites and tags, kept by the core per machine (`cluster/node/vm`) in global state, so they follow the user
 * into every window. The hypervisor never sees them.
 */
import * as vscode from 'vscode';
import type { VmRef } from '../../shared/protocol';
import { allTags, parseTags, type VmMarks } from '../../shared/treeGroups';

const KEY = 'vmm.marks';

const keyOf = (ref: VmRef) => `${ref.clusterId}/${ref.nodeId}/${ref.vmId}`;

export class VmMarksStore implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	constructor(private readonly state: vscode.Memento) {
		void this.updateContext();
	}

	private all(): Record<string, VmMarks> {
		return this.state.get<Record<string, VmMarks>>(KEY) ?? {};
	}

	get(ref: VmRef): VmMarks {
		return this.all()[keyOf(ref)] ?? {};
	}

	isFavorite(ref: VmRef): boolean {
		return !!this.get(ref).favorite;
	}

	tags(ref: VmRef): string[] {
		return this.get(ref).tags ?? [];
	}

	/** Every tag in use, for the tag picker. */
	knownTags(): string[] {
		return allTags(Object.values(this.all()));
	}

	hasFavorites(): boolean {
		return Object.values(this.all()).some((m) => m.favorite);
	}

	async setFavorite(refs: readonly VmRef[], favorite: boolean): Promise<void> {
		await this.change(refs, (m) => ({ ...m, favorite: favorite || undefined }));
	}

	async setTags(refs: readonly VmRef[], tags: readonly string[]): Promise<void> {
		const clean = parseTags(tags);
		await this.change(refs, (m) => ({ ...m, tags: clean.length ? clean : undefined }));
	}

	/** A deleted machine takes its marks with it. */
	async forget(ref: VmRef): Promise<void> {
		const all = this.all();
		if (!(keyOf(ref) in all)) return;
		delete all[keyOf(ref)];
		await this.save(all);
	}

	private async change(refs: readonly VmRef[], update: (marks: VmMarks) => VmMarks): Promise<void> {
		const all = this.all();
		for (const ref of refs) {
			const next = update(all[keyOf(ref)] ?? {});
			if (next.favorite || next.tags?.length) all[keyOf(ref)] = JSON.parse(JSON.stringify(next)) as VmMarks;
			else delete all[keyOf(ref)];
		}
		await this.save(all);
	}

	private async save(all: Record<string, VmMarks>): Promise<void> {
		await this.state.update(KEY, all);
		await this.updateContext();
		this.emitter.fire();
	}

	private async updateContext(): Promise<void> {
		await vscode.commands.executeCommand('setContext', 'vmm.hasTags', this.knownTags().length > 0);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
