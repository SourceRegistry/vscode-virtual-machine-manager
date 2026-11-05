import * as vscode from 'vscode';
import {
	PROVIDER_CONTRIBUTION_KEY,
	VMM_API_VERSION,
	VMM_MIN_API_VERSION,
	checkApiCompatibility,
	type HypervisorProvider,
	type ProviderContribution
} from '@vmm/sdk';
import { log } from '../util/log';

export interface AvailableProvider extends ProviderContribution {
	extensionId: string;
	registered: boolean;
	/** Why the provider cannot run with this core (version mismatch); unset when it can. */
	incompatible?: string;
}

/**
 * Keeps track of providers registered by provider extensions and of providers that are
 * *declared* by installed extensions but not activated yet (lazy activation).
 */
export class ProviderRegistry implements vscode.Disposable {
	private readonly providers = new Map<string, HypervisorProvider>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [this.emitter];

	constructor() {
		this.disposables.push(vscode.extensions.onDidChange(() => this.emitter.fire()));
	}

	register(provider: HypervisorProvider): vscode.Disposable {
		if (this.providers.has(provider.id)) {
			throw new Error(`A hypervisor provider with id "${provider.id}" is already registered`);
		}
		this.providers.set(provider.id, provider);
		log.info(`Provider registered: ${provider.id} (${provider.displayName})`);
		this.emitter.fire();
		return new vscode.Disposable(() => {
			if (this.providers.get(provider.id) === provider) {
				this.providers.delete(provider.id);
				this.emitter.fire();
			}
		});
	}

	get(id: string): HypervisorProvider | undefined {
		return this.providers.get(id);
	}

	/** Providers declared in installed extensions' package.json plus the ones registered at runtime. */
	available(): AvailableProvider[] {
		const result = new Map<string, AvailableProvider>();
		for (const ext of vscode.extensions.all) {
			const declared = ext.packageJSON?.contributes?.[PROVIDER_CONTRIBUTION_KEY] as ProviderContribution[] | undefined;
			if (!Array.isArray(declared)) continue;
			for (const entry of declared) {
				if (!entry?.id) continue;
				result.set(entry.id, {
					...entry,
					displayName: entry.displayName ?? entry.id,
					extensionId: ext.id,
					registered: this.providers.has(entry.id),
					incompatible: checkApiCompatibility(entry.displayName ?? entry.id, entry.apiVersion, { apiVersion: VMM_API_VERSION, minApiVersion: VMM_MIN_API_VERSION }).message
				});
			}
		}
		for (const provider of this.providers.values()) {
			if (!result.has(provider.id)) {
				result.set(provider.id, {
					id: provider.id,
					displayName: provider.displayName,
					extensionId: 'builtin',
					registered: true
				});
			}
		}
		return [...result.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
	}

	displayName(id: string): string {
		return this.providers.get(id)?.displayName ?? this.available().find((p) => p.id === id)?.displayName ?? id;
	}

	/** Returns the provider, activating its extension first when needed. */
	async ensure(id: string): Promise<HypervisorProvider | undefined> {
		const existing = this.providers.get(id);
		if (existing) return existing;
		const declared = this.available().find((p) => p.id === id);
		if (!declared || declared.extensionId === 'builtin') return undefined;
		if (declared.incompatible) {
			log.error(declared.incompatible);
			void vscode.window.showErrorMessage(declared.incompatible);
			return undefined;
		}
		const ext = vscode.extensions.getExtension(declared.extensionId);
		if (!ext) return undefined;
		try {
			await ext.activate();
		} catch (error) {
			log.error(`Activating ${declared.extensionId} failed: ${String(error)}`);
			return undefined;
		}
		return this.providers.get(id);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
