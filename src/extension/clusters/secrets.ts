import { isFieldVisible, type FieldSchema, type FieldValues } from '@vmm/sdk';

/** Secret slot (per cluster) for credentials the core asks for when opening an RDP console. */
export const CONSOLE_CREDENTIALS_KEY = 'console.rdp';

export function secretStorageKey(clusterId: string, field: string): string {
	return `vmm/cluster/${clusterId}/${field}`;
}

/**
 * Split form values into public config and secrets according to the provider schema. Values of fields
 * that do not apply (see `showWhen`) are dropped, so switching a sign-in method leaves nothing behind.
 */
export function splitSecrets(schema: FieldSchema[], values: FieldValues): { config: FieldValues; secrets: Record<string, string | undefined> } {
	const secretFields = new Set(schema.filter((f) => f.secret || f.type === 'password').map((f) => f.key));
	const config: FieldValues = {};
	const secrets: Record<string, string | undefined> = {};
	const hidden = new Set(schema.filter((f) => !isFieldVisible(f, values, schema)).map((f) => f.key));
	for (const [key, value] of Object.entries(values)) {
		if (hidden.has(key)) continue;
		if (secretFields.has(key)) secrets[key] = value === undefined || value === '' ? undefined : String(value);
		else config[key] = value;
	}
	for (const key of secretFields) if (!(key in secrets)) secrets[key] = undefined;
	return { config, secrets };
}
