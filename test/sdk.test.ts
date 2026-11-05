import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
	PROVIDER_CONTRIBUTION_KEY,
	VMM_API_VERSION,
	VMM_MIN_API_VERSION,
	checkApiCompatibility,
	coerceValues,
	fieldDefaults,
	formatMemory,
	formatUptime,
	isFieldVisible,
	validateValues,
	type FieldSchema
} from '@vmm/sdk';
import { secretStorageKey, splitSecrets } from '../src/extension/clusters/secrets';

const schema: FieldSchema[] = [
	{ key: 'host', label: 'Host', type: 'text', required: true },
	{ key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 8006 },
	{ key: 'verify', label: 'Verify TLS', type: 'checkbox', default: true },
	{ key: 'token', label: 'Token', type: 'password', secret: true },
	{ key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'A' }] }
];

describe('field helpers', () => {
	it('collects defaults', () => {
		expect(fieldDefaults(schema)).toEqual({ port: 8006, verify: true });
	});

	it('coerces raw form values to schema types', () => {
		expect(coerceValues(schema, { host: 'pve', port: '8007', verify: 'false', token: 'x', mode: 'a' })).toEqual({
			host: 'pve',
			port: 8007,
			verify: false,
			token: 'x',
			mode: 'a'
		});
		expect(coerceValues(schema, { port: '' })).toEqual({});
	});

	it('validates required, ranges and options', () => {
		expect(validateValues(schema, { port: 1 })).toEqual({ key: 'host', message: 'Host is required' });
		expect(validateValues(schema, { host: 'x', port: 0 })?.key).toBe('port');
		expect(validateValues(schema, { host: 'x', mode: 'b' })?.key).toBe('mode');
		expect(validateValues(schema, { host: 'x', port: 22, mode: 'a' })).toBeUndefined();
	});

	it('formats memory and uptime', () => {
		expect(formatMemory(512)).toBe('512 MB');
		expect(formatMemory(4096)).toBe('4 GB');
		expect(formatMemory(1536)).toBe('1.5 GB');
		expect(formatUptime(3700)).toBe('1h 1m');
		expect(formatUptime(90000)).toBe('1d 1h');
	});
});

describe('secret handling', () => {
	it('keeps secrets out of the persisted config', () => {
		const { config, secrets } = splitSecrets(schema, { host: 'pve', port: 8006, token: 'abc' });
		expect(config).toEqual({ host: 'pve', port: 8006 });
		expect(secrets).toEqual({ token: 'abc' });
	});

	it('marks empty secrets as "keep stored value"', () => {
		expect(splitSecrets(schema, { host: 'pve', token: '' }).secrets).toEqual({ token: undefined });
		expect(splitSecrets(schema, { host: 'pve' }).secrets).toEqual({ token: undefined });
	});

	it('namespaces secret keys per cluster', () => {
		expect(secretStorageKey('c1', 'token')).toBe('vmm/cluster/c1/token');
	});
});

describe('conditional fields', () => {
	const method = { key: 'authMethod', label: 'Method', type: 'select' as const };
	const token = { key: 'token', label: 'Token', type: 'text' as const, required: true, showWhen: { key: 'authMethod', equals: 'token', default: 'token' } };
	const login = { key: 'user', label: 'User', type: 'text' as const, required: true, showWhen: { key: 'authMethod', equals: ['password', 'openid'] } };

	it('shows a field only for the matching value, with a default for older configs', () => {
		expect(isFieldVisible(token, {})).toBe(true);
		expect(isFieldVisible(token, { authMethod: 'password' })).toBe(false);
		expect(isFieldVisible(login, {})).toBe(false);
		expect(isFieldVisible(login, { authMethod: 'openid' })).toBe(true);
		expect(isFieldVisible(method, {})).toBe(true);
	});

	it('does not validate hidden required fields', () => {
		expect(validateValues([method, token, login], { authMethod: 'password', user: 'root' })).toBeUndefined();
		expect(validateValues([method, token, login], { authMethod: 'password' })?.key).toBe('user');
	});

	it('hides a field whose controlling field is itself hidden', () => {
		const remember = { key: 'remember', label: 'Remember', type: 'checkbox' as const, showWhen: { key: 'authMethod', equals: 'password' } };
		const pass = { key: 'pass', label: 'Pass', type: 'password' as const, secret: true, showWhen: { key: 'remember', equals: true } };
		const schema = [method, remember, pass];
		expect(isFieldVisible(pass, { authMethod: 'password', remember: true }, schema)).toBe(true);
		expect(isFieldVisible(pass, { authMethod: 'token', remember: true }, schema)).toBe(false);
		expect(isFieldVisible(pass, { authMethod: 'password', remember: false }, schema)).toBe(false);
		expect(splitSecrets(schema, { authMethod: 'token', remember: true, pass: 'x' })).toEqual({ config: { authMethod: 'token' }, secrets: { pass: undefined } });
		expect(splitSecrets(schema, { authMethod: 'password', remember: true, pass: 'x' }).secrets).toEqual({ pass: 'x' });
	});
});

describe('API compatibility', () => {
	const core = { apiVersion: 3, minApiVersion: 2 };

	it('accepts providers within the core range', () => {
		expect(checkApiCompatibility('X', 2, core).ok).toBe(true);
		expect(checkApiCompatibility('X', 3, core).ok).toBe(true);
	});

	it('rejects a provider newer than the core', () => {
		expect(checkApiCompatibility('X', 4, core)).toMatchObject({ ok: false, update: 'core' });
	});

	it('rejects a provider older than the core minimum', () => {
		expect(checkApiCompatibility('X', 1, core)).toMatchObject({ ok: false, update: 'provider' });
	});

	it('requires an exact match from cores that do not announce a minimum', () => {
		expect(checkApiCompatibility('X', 1, { apiVersion: 2 }).ok).toBe(false);
		expect(checkApiCompatibility('X', 2, { apiVersion: 2 }).ok).toBe(true);
	});

	it('accepts providers that declare no version', () => {
		expect(checkApiCompatibility('X', undefined, core).ok).toBe(true);
	});

	it('keeps the declared version of every bundled provider in sync with the SDK', () => {
		expect(VMM_MIN_API_VERSION).toBeLessThanOrEqual(VMM_API_VERSION);
		for (const name of readdirSync('extensions')) {
			const manifest = JSON.parse(readFileSync(`extensions/${name}/package.json`, 'utf8'));
			for (const provider of manifest.contributes[PROVIDER_CONTRIBUTION_KEY]) expect(provider.apiVersion).toBe(VMM_API_VERSION);
		}
	});
});
