import { describe, expect, it } from 'vitest';
import { coerceValues, fieldDefaults, formatMemory, formatUptime, validateValues, type FieldSchema } from '@vmm/sdk';
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
