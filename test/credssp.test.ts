import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecurityContext } from '@vmm/sdk';
import {
	CredSspError,
	authenticateCredSsp,
	bindingHash,
	credentialLessTsCredentials,
	decodeTsRequest,
	encodeTsRequest,
	subjectPublicKey,
	type TsRequest
} from '../src/extension/rdp/credssp';
import { readTlv } from '../src/extension/rdp/rdcleanpath';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const text = (value: string) => new Uint8Array(Buffer.from(value));
const cert = readFileSync(path.join(__dirname, 'fixtures/rdp-test-cert.pem')).toString();
const certDer = new Uint8Array(Buffer.from(cert.replace(/-----[^-]+-----|\s/g, ''), 'base64'));

/** Stand-in for the session-key cipher: reversible and checked by the fake server. */
const seal = (data: Uint8Array) => new Uint8Array([0xee, ...data.map((b) => b ^ 0x5a)]);
const unseal = (data: Uint8Array) => {
	if (data[0] !== 0xee) throw new Error('not sealed');
	return data.subarray(1).map((b) => b ^ 0x5a);
};

/** Two Negotiate legs: "hello" → (server "world") → "done", then complete. */
function fakeContext(): SecurityContext & { disposed: boolean } {
	let round = 0;
	return {
		disposed: false,
		async step(input) {
			round++;
			if (round === 1) return { token: text('hello'), complete: false };
			expect(Buffer.from(input).toString()).toBe('world');
			return { token: text('done'), complete: true };
		},
		async encrypt(data) {
			return seal(data);
		},
		async decrypt(data) {
			return unseal(data);
		},
		dispose() {
			this.disposed = true;
		}
	};
}

describe('CredSSP codec', () => {
	it('encodes credential-less TSCredentials like IronRDP (type 1, empty password creds)', () => {
		// SEQ { [0] INTEGER 1, [1] OCTET STRING { SEQ { [0] "", [1] "", [2] "" } } }
		expect(hex(credentialLessTsCredentials())).toBe('3017a003020101a110040e300ca0020400a1020400a2020400');
	});

	it('round-trips TSRequests, including NTSTATUS error codes', () => {
		const request: TsRequest = {
			version: 6,
			negoTokens: text('token'),
			pubKeyAuth: text('pk'),
			clientNonce: new Uint8Array(32).fill(1)
		};
		expect(decodeTsRequest(encodeTsRequest(request))).toEqual(request);
		expect(decodeTsRequest(encodeTsRequest({ version: 6, errorCode: 0xc000006d })).errorCode).toBe(0xc000006d);
		// Servers send NTSTATUS as a 4-byte two's-complement INTEGER.
		expect(decodeTsRequest(Buffer.from('300da003020106a4060204c000006d', 'hex')).errorCode).toBe(0xc000006d);
	});

	it('extracts the subjectPublicKey CredSSP binds to', () => {
		const expected = createPublicKey(cert).export({ type: 'pkcs1', format: 'der' });
		expect(Buffer.from(subjectPublicKey(certDer))).toEqual(expected);
	});
});

describe('authenticateCredSsp', () => {
	let server: net.Server | undefined;
	afterEach(() => server?.close());

	async function run(behaviour: 'accept' | 'reject' | 'wrongBinding') {
		const publicKey = text('server-public-key');
		const seen: TsRequest[] = [];
		server = net.createServer((socket) => {
			let buffer = Buffer.alloc(0);
			let stage = 0;
			let nonce: Uint8Array | undefined;
			socket.on('data', (chunk) => {
				buffer = Buffer.concat([buffer, chunk]);
				for (let element = readTlv(buffer); element; element = readTlv(buffer)) {
					const request = decodeTsRequest(buffer.subarray(0, element.size));
					buffer = buffer.subarray(element.size);
					seen.push(request);
					stage++;
					if (stage === 1) {
						socket.write(encodeTsRequest(behaviour === 'reject' ? { version: 6, errorCode: 0xc000006d } : { version: 6, negoTokens: text('world') }));
					} else if (stage === 2) {
						nonce = request.clientNonce!;
						const proof = bindingHash(Buffer.from('CredSSP Server-To-Client Binding Hash\0', 'latin1'), nonce, behaviour === 'wrongBinding' ? text('other') : publicKey);
						socket.write(encodeTsRequest({ version: 6, pubKeyAuth: seal(proof) }));
					} else if (stage === 3) {
						socket.write(Buffer.from('x224')); // what the server sends after X.224, here: anything
					}
				}
			});
		});
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
		const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
		await new Promise((r) => socket.once('connect', r));
		const context = fakeContext();
		const outcome = await authenticateCredSsp(socket, context, publicKey).then(
			() => undefined,
			(error: unknown) => error
		);
		return { outcome, seen, socket, publicKey };
	}

	it('authenticates and sends credential-less TSCredentials bound to the server key', async () => {
		const { outcome, seen, socket, publicKey } = await run('accept');
		expect(outcome).toBeUndefined();
		// The client does not wait for the server to read its last message.
		for (let i = 0; i < 100 && seen.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
		expect(seen).toHaveLength(3);
		expect(Buffer.from(seen[0].negoTokens!).toString()).toBe('hello');
		const [, second, third] = seen;
		expect(Buffer.from(second.negoTokens!).toString()).toBe('done');
		expect(second.clientNonce).toHaveLength(32);
		expect(hex(unseal(second.pubKeyAuth!))).toBe(hex(bindingHash(Buffer.from('CredSSP Client-To-Server Binding Hash\0', 'latin1'), second.clientNonce!, publicKey)));
		expect(hex(unseal(third.authInfo!))).toBe(hex(credentialLessTsCredentials()));
		expect(hex(third.clientNonce!)).toBe(hex(second.clientNonce!));

		// The stream stays usable (paused) for the relay afterwards.
		socket.write(Buffer.alloc(1));
		const next = await new Promise<Buffer>((resolve) => {
			socket.once('data', resolve);
			socket.resume();
		});
		expect(next.toString()).toBe('x224');
		socket.destroy();
	});

	it('reports the server status when the sign-in is rejected', async () => {
		const { outcome, socket } = await run('reject');
		expect(outcome).toBeInstanceOf(CredSspError);
		expect((outcome as CredSspError).status).toBe(0xc000006d);
		expect((outcome as Error).message).toMatch(/STATUS_LOGON_FAILURE/);
		socket.destroy();
	});

	it('refuses a server that cannot prove the certificate key', async () => {
		const { outcome, seen, socket } = await run('wrongBinding');
		expect((outcome as Error).message).toMatch(/binding does not match/);
		expect(seen).toHaveLength(2); // no TSCredentials sent
		socket.destroy();
	});
});
