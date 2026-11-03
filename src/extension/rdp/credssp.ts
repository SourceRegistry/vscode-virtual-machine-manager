/**
 * CredSSP client (MS-CSSP) for single sign-on: authenticates an RDP connection with a native
 * security context (e.g. Windows SSPI with the user's logon) and sends credential-less
 * TSCredentials, so no password is involved. Follows IronRDP's `ironrdp-vmconnect` native path
 * (Devolutions/IronRDP, MIT OR Apache-2.0): TSRequest v6, client nonce and SHA-256 public-key
 * binding (CredSSP v5+).
 */
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { SecurityContext } from '@vmm/sdk';
import { children, concat, readTlv, tlv, type Tlv } from './rdcleanpath';

export const TS_REQUEST_VERSION = 6;
const NONCE_SIZE = 32;
const CLIENT_SERVER_MAGIC = Buffer.from('CredSSP Client-To-Server Binding Hash\0', 'latin1');
const SERVER_CLIENT_MAGIC = Buffer.from('CredSSP Server-To-Client Binding Hash\0', 'latin1');

/** Service class of Hyper-V's VM connection service (VMConnect); ordinary RDP uses `TERMSRV`. */
export const VMCONNECT_SERVICE_CLASS = 'Microsoft Virtual Console Service';

export interface TsRequest {
	version: number;
	negoTokens?: Uint8Array;
	authInfo?: Uint8Array;
	pubKeyAuth?: Uint8Array;
	errorCode?: number;
	clientNonce?: Uint8Array;
}

// ---------------------------------------------------------------------------------------------
// TSRequest codec
// ---------------------------------------------------------------------------------------------

const integer = (value: number): Uint8Array => {
	const bytes: number[] = [];
	for (let n = value >>> 0; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
	if (!bytes.length || bytes[0] & 0x80) bytes.unshift(0);
	return tlv(0x02, Uint8Array.from(bytes));
};
const octets = (value: Uint8Array) => tlv(0x04, value);
const explicit = (n: number, inner: Uint8Array) => tlv(0xa0 | n, inner);

export function encodeTsRequest(request: TsRequest): Uint8Array {
	const fields = [explicit(0, integer(request.version))];
	if (request.negoTokens) {
		// NegoData ::= SEQUENCE OF SEQUENCE { negoToken [0] OCTET STRING }
		fields.push(explicit(1, tlv(0x30, tlv(0x30, explicit(0, octets(request.negoTokens))))));
	}
	if (request.authInfo) fields.push(explicit(2, octets(request.authInfo)));
	if (request.pubKeyAuth) fields.push(explicit(3, octets(request.pubKeyAuth)));
	if (request.errorCode !== undefined) fields.push(explicit(4, integer(request.errorCode)));
	if (request.clientNonce) fields.push(explicit(5, octets(request.clientNonce)));
	return tlv(0x30, concat(fields));
}

function inner(field: Tlv): Tlv {
	const [value] = children(field.value);
	if (!value) throw new Error('Empty CredSSP field');
	return value;
}

function unsigned(element: Tlv): number {
	// NTSTATUS error codes arrive as 4-byte (two's complement) INTEGERs; read them unsigned.
	let value = 0;
	for (const byte of element.value.subarray(-4)) value = value * 256 + byte;
	return value >>> 0;
}

export function decodeTsRequest(bytes: Uint8Array): TsRequest {
	const root = readTlv(bytes);
	if (!root || root.tag !== 0x30) throw new Error('Invalid CredSSP TSRequest');
	const request: TsRequest = { version: 0 };
	for (const field of children(root.value)) {
		switch (field.tag) {
			case 0xa0:
				request.version = unsigned(inner(field));
				break;
			case 0xa1: {
				const item = children(inner(field).value)[0];
				const token = item && children(item.value).find((c) => c.tag === 0xa0);
				if (token) request.negoTokens = inner(token).value.slice();
				break;
			}
			case 0xa2:
				request.authInfo = inner(field).value.slice();
				break;
			case 0xa3:
				request.pubKeyAuth = inner(field).value.slice();
				break;
			case 0xa4:
				request.errorCode = unsigned(inner(field));
				break;
			case 0xa5:
				request.clientNonce = inner(field).value.slice();
				break;
		}
	}
	return request;
}

/**
 * TSCredentials { credType 1 (password), TSPasswordCreds { "", "", "" } } — the credential-less
 * form IronRDP's native client sends: the server authenticated the user with the security
 * context and needs no delegated secret.
 */
export function credentialLessTsCredentials(): Uint8Array {
	const empty = octets(new Uint8Array());
	const passwordCreds = tlv(0x30, concat([explicit(0, empty), explicit(1, empty), explicit(2, empty)]));
	return tlv(0x30, concat([explicit(0, integer(1)), explicit(1, octets(passwordCreds))]));
}

/** `subjectPublicKey` (BIT STRING contents) of a DER certificate — what CredSSP binds to. */
export function subjectPublicKey(certificateDer: Uint8Array): Uint8Array {
	const spki = new X509Certificate(Buffer.from(certificateDer)).publicKey.export({ type: 'spki', format: 'der' });
	const root = readTlv(spki);
	const bitString = root && children(root.value).find((c) => c.tag === 0x03);
	if (!bitString || bitString.value[0] !== 0) throw new Error('Unexpected certificate public key encoding');
	return bitString.value.slice(1);
}

export function bindingHash(magic: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array): Uint8Array {
	return new Uint8Array(createHash('sha256').update(magic).update(nonce).update(publicKey).digest());
}

// ---------------------------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------------------------

export class CredSspError extends Error {
	constructor(
		message: string,
		/** NTSTATUS from the server, e.g. 0xC000006D (STATUS_LOGON_FAILURE). */
		readonly status?: number
	) {
		super(message);
	}
}

const NTSTATUS_NAMES: Record<number, string> = {
	0xc000006d: 'STATUS_LOGON_FAILURE',
	0xc000006e: 'STATUS_ACCOUNT_RESTRICTION',
	0xc0000022: 'STATUS_ACCESS_DENIED',
	0xc000015b: 'STATUS_LOGON_TYPE_NOT_GRANTED'
};

function checkError(request: TsRequest): void {
	if (request.errorCode !== undefined && request.errorCode !== 0) {
		const hex = `0x${request.errorCode.toString(16).toUpperCase().padStart(8, '0')}`;
		const name = NTSTATUS_NAMES[request.errorCode];
		throw new CredSspError(`the server rejected the sign-in (${name ? `${name}, ` : ''}${hex})`, request.errorCode);
	}
}

/** Reads whole DER elements from a stream that is otherwise unread. */
class TsRequestReader {
	private buffer: Buffer = Buffer.alloc(0);
	private waiting: { resolve(value: Uint8Array): void; reject(error: Error): void } | undefined;
	private failure: Error | undefined;

	constructor(private readonly stream: Duplex) {
		stream.on('data', this.onData);
		stream.on('error', this.onError);
		stream.on('close', this.onClose);
	}

	private readonly onData = (chunk: Buffer) => {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		this.flush();
	};
	private readonly onError = (error: Error) => this.fail(error);
	private readonly onClose = () => this.fail(new Error('the RDP server closed the connection during sign-in'));

	private fail(error: Error) {
		this.failure ??= error;
		this.waiting?.reject(error);
		this.waiting = undefined;
	}

	private flush() {
		if (!this.waiting) return;
		const element = readTlv(this.buffer);
		if (!element) return;
		const bytes = this.buffer.subarray(0, element.size);
		this.buffer = this.buffer.subarray(element.size);
		const { resolve } = this.waiting;
		this.waiting = undefined;
		resolve(bytes);
	}

	read(): Promise<Uint8Array> {
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiting = { resolve, reject };
			this.flush();
		});
	}

	/** Stops reading and returns bytes received beyond the last element. */
	detach(): Buffer {
		this.stream.off('data', this.onData);
		this.stream.off('error', this.onError);
		this.stream.off('close', this.onClose);
		this.stream.pause();
		return this.buffer;
	}
}

/**
 * Runs CredSSP over `stream` (the TLS connection to the RDP server). Resolves when the server
 * accepted the credential-less TSCredentials; the connection then continues with X.224.
 */
export async function authenticateCredSsp(stream: Duplex, context: SecurityContext, serverPublicKey: Uint8Array): Promise<void> {
	const reader = new TsRequestReader(stream);
	const nonce = new Uint8Array(randomBytes(NONCE_SIZE));
	const write = (request: TsRequest) => stream.write(encodeTsRequest(request));
	try {
		let input: Uint8Array = new Uint8Array();
		let peerVersion: number | undefined;
		for (let round = 0; ; round++) {
			if (round > 20) throw new CredSspError('the sign-in did not complete');
			const step = await context.step(input);
			const request: TsRequest = { version: TS_REQUEST_VERSION, negoTokens: step.token.length ? step.token : undefined };
			if (step.complete) {
				if (peerVersion === undefined || peerVersion < 5) {
					throw new CredSspError(`the RDP server speaks CredSSP ${peerVersion ?? 'unknown'}; single sign-on needs version 5 or later`);
				}
				request.pubKeyAuth = await context.encrypt(bindingHash(CLIENT_SERVER_MAGIC, nonce, serverPublicKey), 0);
				request.clientNonce = nonce;
				write(request);
				break;
			}
			write(request);
			const response = decodeTsRequest(await reader.read());
			checkError(response);
			if (peerVersion !== undefined && peerVersion !== response.version) throw new CredSspError('the server changed CredSSP version');
			peerVersion = response.version;
			input = response.negoTokens ?? new Uint8Array();
		}

		const response = decodeTsRequest(await reader.read());
		checkError(response);
		if (!response.pubKeyAuth) throw new CredSspError('the server did not prove it holds the certificate key');
		const binding = await context.decrypt(response.pubKeyAuth, 0);
		const expected = bindingHash(SERVER_CLIENT_MAGIC, nonce, serverPublicKey);
		if (Buffer.compare(Buffer.from(binding), Buffer.from(expected)) !== 0) {
			throw new CredSspError('the server public-key binding does not match its certificate');
		}

		write({
			version: TS_REQUEST_VERSION,
			authInfo: await context.encrypt(credentialLessTsCredentials(), 1),
			clientNonce: response.version >= 5 ? nonce : undefined
		});
	} finally {
		const leftover = reader.detach();
		if (leftover.length) stream.unshift(leftover);
	}
}
