import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import path from 'node:path';
import * as tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
	RDCLEANPATH_VERSION,
	decodePdu,
	encodePdu,
	encodePreconnectionBlobV2,
	pduLength,
	tpktLength,
	vmConnectPayload,
	type RDCleanPathPdu
} from '../src/extension/rdp/rdcleanpath';
import { RdpGateway } from '../src/extension/rdp/RdpGateway';

// Throwaway self-signed certificate for the fake RDP server (test fixture, not a secret).
const key = readFileSync(path.join(__dirname, 'fixtures/rdp-test-key.pem'));
const cert = readFileSync(path.join(__dirname, 'fixtures/rdp-test-cert.pem'));
const certDer = new Uint8Array(Buffer.from(cert.toString().replace(/-----[^-]+-----|\s/g, ''), 'base64'));

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('RDCleanPath codec', () => {
	it('encodes the version as an explicit [0] INTEGER inside a SEQUENCE', () => {
		// 3390 = 0x0D3E → 30 06 a0 04 02 02 0d 3e
		expect(hex(encodePdu({ version: RDCLEANPATH_VERSION }))).toBe('3006a00402020d3e');
	});

	it('round-trips a VMConnect request and a response with a certificate chain', () => {
		const request: RDCleanPathPdu = {
			version: RDCLEANPATH_VERSION,
			destination: 'DESKTOP-ALEX:2179',
			proxyAuth: 'token',
			preconnectionBlob: vmConnectPayload('0b2a6f0e-1111-2222-3333-444455556666', 'basic')
		};
		expect(decodePdu(encodePdu(request))).toEqual(request);

		const big = new Uint8Array(70_000).fill(7); // multi-byte DER lengths
		const response: RDCleanPathPdu = {
			version: RDCLEANPATH_VERSION,
			x224ConnectionPdu: Uint8Array.of(3, 0, 0, 11, 6, 0xd0, 0, 0, 0x12, 0x34, 0),
			serverCertChain: [certDer, big],
			serverAddr: '127.0.0.1:2179'
		};
		expect(decodePdu(encodePdu(response))).toEqual(response);
	});

	it('round-trips errors', () => {
		const pdu: RDCleanPathPdu = { version: RDCLEANPATH_VERSION, error: { errorCode: 105, tlsAlertCode: 40 } };
		expect(decodePdu(encodePdu(pdu))).toEqual(pdu);
	});

	it('reports when more bytes are needed', () => {
		const bytes = encodePdu({ version: RDCLEANPATH_VERSION, destination: 'x'.repeat(300) });
		expect(pduLength(bytes.subarray(0, 1))).toBeUndefined();
		expect(pduLength(bytes.subarray(0, 3))).toBeUndefined();
		expect(pduLength(bytes.subarray(0, bytes.length - 1))).toBeUndefined();
		expect(pduLength(Buffer.concat([bytes, Buffer.from([1, 2])]))).toBe(bytes.length);
	});

	it('rejects other versions', () => {
		expect(() => decodePdu(encodePdu({ version: 1 }))).toThrow(/version/);
	});

	it('encodes the Hyper-V pre-connection blob V2 (MS-RDPEPS)', () => {
		const blob = encodePreconnectionBlobV2('AB');
		// cbSize=24, flags=0, version=2, id=0, cchPCB=3, "A\0B\0\0\0"
		expect(hex(blob)).toBe('18000000' + '00000000' + '02000000' + '00000000' + '0300' + '410042000000');
		expect(vmConnectPayload('id', 'enhanced')).toBe('id;EnhancedMode=1');
	});

	it('frames TPKT packets', () => {
		expect(tpktLength(Uint8Array.of(3, 0, 0, 6, 1))).toBeUndefined();
		expect(tpktLength(Uint8Array.of(3, 0, 0, 5, 1, 9))).toBe(5);
		expect(() => tpktLength(Uint8Array.of(9, 0, 0, 5))).toThrow();
	});
});

/** Fake Hyper-V endpoint: expects a PCB V2, then speaks TLS and echoes upper-cased text. */
function fakeVmConnectServer(onPcb: (pcb: Buffer) => void): Promise<net.Server> {
	return new Promise((resolve) => {
		const server = net.createServer((socket) => {
			let buffer = Buffer.alloc(0);
			const onData = (chunk: Buffer) => {
				buffer = Buffer.concat([buffer, chunk]);
				if (buffer.length < 4) return;
				const size = buffer.readUInt32LE(0);
				if (buffer.length < size) return;
				socket.off('data', onData);
				socket.pause();
				// The TLS ClientHello may arrive in the same chunk as the PCB.
				if (buffer.length > size) socket.unshift(buffer.subarray(size));
				onPcb(buffer.subarray(0, size));
				const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
				secure.on('data', (data: Buffer) => secure.write(data.toString().toUpperCase()));
				secure.on('error', () => undefined);
			};
			socket.on('data', onData);
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

describe('RdpGateway', () => {
	let server: net.Server | undefined;
	afterEach(() => server?.close());

	async function run(options: { token?: string; payload?: string; requestPayload?: string }) {
		let pcb: Buffer | undefined;
		server = await fakeVmConnectServer((b) => (pcb = b));
		const port = (server.address() as net.AddressInfo).port;
		const toClient: Uint8Array[] = [];
		let closed: { error?: string } | undefined;
		const gateway = new RdpGateway({
			authToken: 'secret',
			open: async () => {
				const socket = net.connect(port, '127.0.0.1');
				await new Promise((r) => socket.once('connect', r));
				return { stream: socket, dispose: () => socket.destroy(), serverName: '127.0.0.1', vmConnectPayload: options.payload ?? 'vm-1' };
			},
			send: (data) => toClient.push(new Uint8Array(data)),
			close: (error) => (closed = { error })
		});
		const request = encodePdu({
			version: RDCLEANPATH_VERSION,
			destination: 'host:2179',
			proxyAuth: options.token ?? 'secret',
			preconnectionBlob: options.requestPayload ?? 'vm-1'
		});
		// Deliver the request in two pieces, like a WebSocket might.
		gateway.write(request.subarray(0, 5));
		gateway.write(request.subarray(5));
		const until = async (check: () => boolean) => {
			for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
		};
		await until(() => toClient.length > 0 || !!closed);
		return { gateway, toClient, pcb: () => pcb, closed: () => closed, until };
	}

	it('sends the PCB, does TLS, returns the certificate chain and relays plaintext', async () => {
		const { gateway, toClient, pcb, until } = await run({});
		const response = decodePdu(toClient[0]);
		expect(response.error).toBeUndefined();
		expect(response.x224ConnectionPdu).toBeUndefined();
		expect(response.serverCertChain?.[0]).toEqual(certDer);
		expect(response.serverAddr).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(pcb()).toEqual(Buffer.from(encodePreconnectionBlobV2('vm-1')));

		gateway.write(new TextEncoder().encode('hello'));
		await until(() => toClient.length > 1);
		expect(Buffer.from(Buffer.concat(toClient.slice(1))).toString()).toBe('HELLO');
		gateway.dispose();
	});

	it('rejects a wrong proxy token without connecting', async () => {
		const { toClient, pcb, closed } = await run({ token: 'nope' });
		expect(decodePdu(toClient[0]).error?.errorCode).toBe(1);
		expect(closed()?.error).toMatch(/proxy token/);
		expect(pcb()).toBeUndefined();
	});

	it('refuses a request for a different virtual machine', async () => {
		const { toClient, pcb, closed } = await run({ requestPayload: 'other-vm' });
		expect(decodePdu(toClient[0]).error?.errorCode).toBe(1);
		expect(closed()?.error).toMatch(/does not match/);
		expect(pcb()).toBeUndefined();
	});
});
