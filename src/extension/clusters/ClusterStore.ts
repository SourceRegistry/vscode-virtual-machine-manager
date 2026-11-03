import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ClusterConfig, FieldSchema, FieldValues, SecretBag } from '@vmm/sdk';
import { CONSOLE_CREDENTIALS_KEY, secretStorageKey, splitSecrets } from './secrets';

export { secretStorageKey, splitSecrets };

const STATE_KEY = 'vmm.clusters';

/** Persisted record. Secret values are never part of it, only the names of the stored secrets. */
export interface StoredCluster extends ClusterConfig {
	secretKeys: string[];
}

export interface ClusterInput {
	name: string;
	providerId: string;
	values: FieldValues;
	schema: FieldSchema[];
}

/**
 * Cluster configuration store. Non-secret config lives in global state (synced with Settings Sync),
 * secret fields live in SecretStorage (OS keychain, not synced).
 */
export class ClusterStore implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		context.globalState.setKeysForSync([STATE_KEY]);
	}

	all(): StoredCluster[] {
		return this.context.globalState.get<StoredCluster[]>(STATE_KEY, []);
	}

	get(id: string): StoredCluster | undefined {
		return this.all().find((c) => c.id === id);
	}

	async add(input: ClusterInput): Promise<StoredCluster> {
		const id = randomUUID();
		const { config, secrets } = splitSecrets(input.schema, input.values);
		const cluster: StoredCluster = { id, name: input.name, providerId: input.providerId, config, secretKeys: [] };
		cluster.secretKeys = await this.writeSecrets(id, secrets, []);
		await this.save([...this.all(), cluster]);
		return cluster;
	}

	/** Empty secret values keep the stored secret. */
	async update(id: string, input: ClusterInput): Promise<StoredCluster> {
		const existing = this.get(id);
		if (!existing) throw new Error('Cluster not found');
		const { config, secrets } = splitSecrets(input.schema, input.values);
		const keep = Object.entries(secrets)
			.filter(([, v]) => v === undefined)
			.map(([k]) => k)
			.filter((k) => existing.secretKeys.includes(k));
		const secretKeys = await this.writeSecrets(id, secrets, keep);
		const updated: StoredCluster = { ...existing, name: input.name, config, secretKeys };
		await this.save(this.all().map((c) => (c.id === id ? updated : c)));
		return updated;
	}

	async remove(id: string): Promise<void> {
		const existing = this.get(id);
		if (!existing) return;
		for (const key of existing.secretKeys) await this.context.secrets.delete(secretStorageKey(id, key));
		// Console credentials the core stored for this cluster (see rdp/credentials.ts).
		await this.context.secrets.delete(secretStorageKey(id, CONSOLE_CREDENTIALS_KEY));
		await this.save(this.all().filter((c) => c.id !== id));
	}

	async secrets(cluster: StoredCluster): Promise<SecretBag> {
		const bag: Record<string, string | undefined> = {};
		for (const key of cluster.secretKeys) bag[key] = await this.context.secrets.get(secretStorageKey(cluster.id, key));
		return Object.freeze(bag);
	}

	private async writeSecrets(id: string, secrets: Record<string, string | undefined>, keep: string[]): Promise<string[]> {
		const stored = new Set(keep);
		for (const [key, value] of Object.entries(secrets)) {
			if (value === undefined) continue;
			await this.context.secrets.store(secretStorageKey(id, key), value);
			stored.add(key);
		}
		return [...stored];
	}

	private async save(clusters: StoredCluster[]): Promise<void> {
		await this.context.globalState.update(STATE_KEY, clusters);
		this.emitter.fire();
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
