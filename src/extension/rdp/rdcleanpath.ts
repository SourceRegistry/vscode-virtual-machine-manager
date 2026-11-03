/**
 * RDCleanPath PDU codec (DER), the handshake IronRDP's web client speaks with its gateway.
 * Mirrors `ironrdp-rdcleanpath` (Devolutions/IronRDP, MIT OR Apache-2.0):
 *
 *   RDCleanPathPdu ::= SEQUENCE {            -- every field EXPLICIT [n]
 *     version            [0] INTEGER,          -- 3390
 *     error              [1] RDCleanPathErr OPTIONAL,
 *     destination        [2] UTF8String OPTIONAL,
 *     proxy_auth         [3] UTF8String OPTIONAL,
 *     server_auth        [4] UTF8String OPTIONAL,
 *     preconnection_blob [5] UTF8String OPTIONAL,
 *     x224_connection_pdu[6] OCTET STRING OPTIONAL,
 *     server_cert_chain  [7] SEQUENCE OF OCTET STRING OPTIONAL,
 *     server_addr        [9] UTF8String OPTIONAL }
 *   RDCleanPathErr ::= SEQUENCE {
 *     error_code [0] INTEGER, http_status_code [1] INTEGER OPTIONAL,
 *     wsa_last_error [2] INTEGER OPTIONAL, tls_alert_code [3] INTEGER OPTIONAL }
 *
 * Pure (no Node/VS Code APIs) so it can be unit-tested.
 */

export const RDCLEANPATH_VERSION = 3390;

export const RDCleanPathErrorCode = {
	General: 1,
	Negotiation: 2,
	TargetUnreachable: 103,
	DnsResolutionFailed: 104,
	TlsHandshakeFailed: 105
} as const;

export interface RDCleanPathError {
	errorCode: number;
	httpStatusCode?: number;
	wsaLastError?: number;
	tlsAlertCode?: number;
}

export interface RDCleanPathPdu {
	version: number;
	error?: RDCleanPathError;
	destination?: string;
	proxyAuth?: string;
	serverAuth?: string;
	preconnectionBlob?: string;
	x224ConnectionPdu?: Uint8Array;
	serverCertChain?: Uint8Array[];
	serverAddr?: string;
}

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8_STRING = 0x0c;
const TAG_SEQUENCE = 0x30;
const contextTag = (n: number) => 0xa0 | n;

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

function encodeLength(length: number): Uint8Array {
	if (length < 0x80) return Uint8Array.of(length);
	const bytes: number[] = [];
	for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
	return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, value: Uint8Array): Uint8Array {
	return concat([Uint8Array.of(tag), encodeLength(value.length), value]);
}

function encodeInteger(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Unsupported INTEGER ${value}`);
	const bytes: number[] = [];
	for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
	if (!bytes.length || bytes[0] & 0x80) bytes.unshift(0);
	return tlv(TAG_INTEGER, Uint8Array.from(bytes));
}

const encodeUtf8 = (value: string) => tlv(TAG_UTF8_STRING, new TextEncoder().encode(value));
const encodeOctets = (value: Uint8Array) => tlv(TAG_OCTET_STRING, value);
const explicit = (n: number, inner: Uint8Array) => tlv(contextTag(n), inner);

function encodeError(error: RDCleanPathError): Uint8Array {
	const fields = [explicit(0, encodeInteger(error.errorCode))];
	if (error.httpStatusCode !== undefined) fields.push(explicit(1, encodeInteger(error.httpStatusCode)));
	if (error.wsaLastError !== undefined) fields.push(explicit(2, encodeInteger(error.wsaLastError)));
	if (error.tlsAlertCode !== undefined) fields.push(explicit(3, encodeInteger(error.tlsAlertCode)));
	return tlv(TAG_SEQUENCE, concat(fields));
}

export function encodePdu(pdu: RDCleanPathPdu): Uint8Array {
	const fields = [explicit(0, encodeInteger(pdu.version))];
	if (pdu.error) fields.push(explicit(1, encodeError(pdu.error)));
	if (pdu.destination !== undefined) fields.push(explicit(2, encodeUtf8(pdu.destination)));
	if (pdu.proxyAuth !== undefined) fields.push(explicit(3, encodeUtf8(pdu.proxyAuth)));
	if (pdu.serverAuth !== undefined) fields.push(explicit(4, encodeUtf8(pdu.serverAuth)));
	if (pdu.preconnectionBlob !== undefined) fields.push(explicit(5, encodeUtf8(pdu.preconnectionBlob)));
	if (pdu.x224ConnectionPdu) fields.push(explicit(6, encodeOctets(pdu.x224ConnectionPdu)));
	if (pdu.serverCertChain) {
		fields.push(explicit(7, tlv(TAG_SEQUENCE, concat(pdu.serverCertChain.map(encodeOctets)))));
	}
	if (pdu.serverAddr !== undefined) fields.push(explicit(9, encodeUtf8(pdu.serverAddr)));
	return tlv(TAG_SEQUENCE, concat(fields));
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

export interface Tlv {
	tag: number;
	value: Uint8Array;
	/** Total encoded size including tag and length. */
	size: number;
}

/** Reads one TLV; `undefined` when `bytes` does not hold a complete element yet. */
export function readTlv(bytes: Uint8Array, offset = 0): Tlv | undefined {
	if (bytes.length < offset + 2) return undefined;
	const tag = bytes[offset];
	let length = bytes[offset + 1];
	let header = 2;
	if (length & 0x80) {
		const count = length & 0x7f;
		if (count === 0 || count > 4) throw new Error('Invalid DER length');
		if (bytes.length < offset + 2 + count) return undefined;
		length = 0;
		for (let i = 0; i < count; i++) length = length * 256 + bytes[offset + 2 + i];
		header += count;
	}
	if (bytes.length < offset + header + length) return undefined;
	return { tag, value: bytes.subarray(offset + header, offset + header + length), size: header + length };
}

export function children(value: Uint8Array): Tlv[] {
	const result: Tlv[] = [];
	for (let offset = 0; offset < value.length; ) {
		const child = readTlv(value, offset);
		if (!child) throw new Error('Truncated DER element');
		result.push(child);
		offset += child.size;
	}
	return result;
}

function expect(element: Tlv, tag: number, what: string): Uint8Array {
	if (element.tag !== tag) throw new Error(`Unexpected DER tag 0x${element.tag.toString(16)} for ${what}`);
	return element.value;
}

function decodeInteger(element: Tlv): number {
	let value = 0;
	for (const byte of expect(element, TAG_INTEGER, 'INTEGER')) value = value * 256 + byte;
	return value;
}

function unwrap(element: Tlv): Tlv {
	const [inner] = children(element.value);
	if (!inner) throw new Error('Empty explicit tag');
	return inner;
}

const decodeUtf8 = (element: Tlv) => new TextDecoder().decode(expect(unwrap(element), TAG_UTF8_STRING, 'UTF8String'));

/**
 * Size of the first complete PDU in `bytes`, or `undefined` when more bytes are needed.
 */
export function pduLength(bytes: Uint8Array): number | undefined {
	const element = readTlv(bytes);
	return element?.size;
}

export function decodePdu(bytes: Uint8Array): RDCleanPathPdu {
	const root = readTlv(bytes);
	if (!root) throw new Error('Incomplete RDCleanPath PDU');
	const pdu: RDCleanPathPdu = { version: 0 };
	for (const field of children(expect(root, TAG_SEQUENCE, 'RDCleanPathPdu'))) {
		switch (field.tag) {
			case contextTag(0):
				pdu.version = decodeInteger(unwrap(field));
				break;
			case contextTag(1): {
				const error: RDCleanPathError = { errorCode: 0 };
				for (const item of children(expect(unwrap(field), TAG_SEQUENCE, 'RDCleanPathErr'))) {
					const value = decodeInteger(unwrap(item));
					if (item.tag === contextTag(0)) error.errorCode = value;
					else if (item.tag === contextTag(1)) error.httpStatusCode = value;
					else if (item.tag === contextTag(2)) error.wsaLastError = value;
					else if (item.tag === contextTag(3)) error.tlsAlertCode = value;
				}
				pdu.error = error;
				break;
			}
			case contextTag(2):
				pdu.destination = decodeUtf8(field);
				break;
			case contextTag(3):
				pdu.proxyAuth = decodeUtf8(field);
				break;
			case contextTag(4):
				pdu.serverAuth = decodeUtf8(field);
				break;
			case contextTag(5):
				pdu.preconnectionBlob = decodeUtf8(field);
				break;
			case contextTag(6):
				pdu.x224ConnectionPdu = expect(unwrap(field), TAG_OCTET_STRING, 'x224_connection_pdu').slice();
				break;
			case contextTag(7):
				pdu.serverCertChain = children(expect(unwrap(field), TAG_SEQUENCE, 'server_cert_chain')).map((c) =>
					expect(c, TAG_OCTET_STRING, 'certificate').slice()
				);
				break;
			case contextTag(9):
				pdu.serverAddr = decodeUtf8(field);
				break;
			default:
			// Unknown fields are ignored (forward compatible).
		}
	}
	if (pdu.version !== RDCLEANPATH_VERSION) throw new Error(`Unsupported RDCleanPath version ${pdu.version}`);
	return pdu;
}

// ---------------------------------------------------------------------------------------------
// Hyper-V pre-connection blob (MS-RDPEPS RDP_PRECONNECTION_PDU_V2)
// ---------------------------------------------------------------------------------------------

/** `cbSize, flags=0, version=2, id=0, cchPCB` (little endian) + null-terminated UTF-16LE payload. */
export function encodePreconnectionBlobV2(payload: string): Uint8Array {
	const chars = payload.length + 1;
	const size = 16 + 2 + chars * 2;
	const bytes = new Uint8Array(size);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, size, true);
	view.setUint32(4, 0, true);
	view.setUint32(8, 2, true);
	view.setUint32(12, 0, true);
	view.setUint16(16, chars, true);
	for (let i = 0; i < payload.length; i++) view.setUint16(18 + i * 2, payload.charCodeAt(i), true);
	return bytes;
}

/** VMConnect payload: `<vm id>` for the basic console, `<vm id>;EnhancedMode=1` for Enhanced Session. */
export function vmConnectPayload(vmId: string, mode: 'basic' | 'enhanced'): string {
	return mode === 'enhanced' ? `${vmId};EnhancedMode=1` : vmId;
}

/** Length of the TPKT-framed X.224 PDU at the start of `bytes` (RFC 1006), if complete. */
export function tpktLength(bytes: Uint8Array): number | undefined {
	if (bytes.length < 4) return undefined;
	if (bytes[0] !== 3) throw new Error('Expected a TPKT header from the RDP server');
	const length = (bytes[2] << 8) | bytes[3];
	return bytes.length >= length ? length : undefined;
}

export function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
