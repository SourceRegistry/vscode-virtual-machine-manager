import type { FieldSchema, FieldValues } from '@vmm/sdk';

export function secretStorageKey(clusterId: string, field: string): string {
	return `vmm/cluster/${clusterId}/${field}`;
}

/** Split form values into public config and secrets according to the provider schema. */
export function splitSecrets(schema: FieldSchema[], values: FieldValues): { config: FieldValues; secrets: Record<string, string | undefined> } {
	const secretFields = new Set(schema.filter((f) => f.secret || f.type === 'password').map((f) => f.key));
	const config: FieldValues = {};
	const secrets: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(values)) {
		if (secretFields.has(key)) secrets[key] = value === undefined || value === '' ? undefined : String(value);
		else config[key] = value;
	}
	for (const key of secretFields) if (!(key in secrets)) secrets[key] = undefined;
	return { config, secrets };
}
