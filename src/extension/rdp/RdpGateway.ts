/**
 * Minimal RDCleanPath gateway running on the extension host.
 *
 * IronRDP's web client cannot open TCP or do TLS itself, so it hands those steps to a gateway:
 *
 *   client ── RDCleanPath request (DER) ──▶ gateway
 *                                           ├─ TCP to the RDP endpoint (provided by the hypervisor)
 *                                           ├─ Hyper-V: pre-connection blob V2 with the VM id
 *                                           │  ordinary RDP: forward X.224 request, read X.224 confirm
 *                                           ├─ TLS handshake with the server
 *   client ◀── RDCleanPath response ────────┘  (server certificate chain [+ X.224 confirm])
 *   client ◀═══ plaintext RDP / CredSSP ═══▶ gateway ◀═══ TLS ═══▶ server
 *
 * The client authenticates with CredSSP over the relayed stream and binds it to the server's
 * public key from the certificate chain, so the gateway never sees the user's credentials in
 * clear-text protocol fields it would have to handle.
 */
import * as net from 'node:net';
import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';
import type { SecurityContext } from '@vmm/sdk';
import { authenticateCredSsp, subjectPublicKey, VMCONNECT_SERVICE_CLASS } from './credssp';
import {
	RDCLEANPATH_VERSION,
	RDCleanPathErrorCode,
	decodePdu,
	encodePdu,
	encodePreconnectionBlobV2,
	pduLength,
	tpktLength,
	type RDCleanPathPdu
} from './rdcleanpath';

export interface GatewayTarget {
	/** Raw TCP stream to the RDP endpoint. */
	stream: Duplex;
	dispose(): void;
	/** Hyper-V VMConnect payload the gateway must send; the client's request has to match it. */
	vmConnectPayload?: string;
	/** Host name used for TLS SNI (omitted for IP addresses). */
	serverName: string;
	/** Single sign-on: security context for CredSSP, used when the client asks the gateway to authenticate. */
	createSecurityContext?(targetName: string): Promise<SecurityContext>;
}

/**
 * Suffix on the client's VMConnect payload asking the gateway to run CredSSP itself (single
 * sign-on). Private to VM Manager's client and gateway (see scripts/ironrdp-patches); stripped
 * before the pre-connection blob is sent to Hyper-V.
 */
export const PROXY_CREDSSP_MARKER = ';VmmProxyCredssp=1';

/** RDCleanPath implementation-specific error code: single sign-on failed. */
export const SINGLE_SIGN_ON_FAILED = 0x4001;

export interface GatewayOptions {
	/** Per-session secret the client must echo as `proxy_auth`. */
	authToken: string;
	/** Opens the connection to the RDP endpoint once a valid request arrived. */
	open(request: RDCleanPathPdu): Promise<GatewayTarget>;
	/** Bytes to the client. */
	send(data: Uint8Array): void;
	/** The relay is over (error text when it failed; `singleSignOnFailed` when CredSSP was the cause). */
	close(error?: string, details?: { singleSignOnFailed?: boolean }): void;
	log?(message: string): void;
	/** Test hook: extra TLS options (e.g. a test CA). */
	tlsOptions?: tls.ConnectionOptions;
}

/**
 * TLS settings for RDP servers whose certificate only allows key encipherment, not signatures —
 * Hyper-V's VM connection service uses such a self-signed certificate. TLS 1.3 and ECDHE suites
 * need the server to sign, which BoringSSL (VS Code's Electron) refuses for such a certificate
 * (KEY_USAGE_BIT_INCORRECT), while Windows' Schannel and OpenSSL ignore it. RSA key exchange uses
 * exactly the key-encipherment right. It has no forward secrecy; the connection is local
 * (127.0.0.1) for Hyper-V, and CredSSP still binds authentication to this certificate.
 */
const RSA_KEY_EXCHANGE: tls.ConnectionOptions = {
	maxVersion: 'TLSv1.2',
	ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA'
};

/** Destinations that needed RSA_KEY_EXCHANGE, so later connections skip the failing attempt. */
const keyUsageFallbackHosts = new Set<string>();

class GatewayError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly tlsAlertCode?: number
	) {
		super(message);
	}
}

export class RdpGateway {
	private state: 'request' | 'connecting' | 'relay' | 'closed' = 'request';
	private pending: Buffer = Buffer.alloc(0);
	private target: GatewayTarget | undefined;
	private secure: tls.TLSSocket | undefined;
	/** The client asked the gateway to authenticate (CredSSP) with the target's security context. */
	private singleSignOn = false;
	private bytesToServer = 0;
	private bytesToClient = 0;

	constructor(private readonly options: GatewayOptions) {}

	/** Bytes from the client. */
	write(chunk: Uint8Array): void {
		switch (this.state) {
			case 'relay':
				this.bytesToServer += chunk.length;
				this.secure?.write(chunk);
				return;
			case 'closed':
				return;
			default:
				this.pending = Buffer.concat([this.pending, chunk]);
				if (this.state === 'request') this.tryHandshake();
		}
	}

	dispose(): void {
		this.finish();
	}

	private tryHandshake(): void {
		let length: number | undefined;
		try {
			length = pduLength(this.pending);
		} catch (error) {
			this.fail(new GatewayError(`Invalid RDCleanPath request: ${message(error)}`, RDCleanPathErrorCode.General));
			return;
		}
		if (length === undefined) return;
		const requestBytes = this.pending.subarray(0, length);
		this.pending = this.pending.subarray(length);
		this.state = 'connecting';
		void this.handshake(requestBytes).catch((error) =>
			this.fail(error instanceof GatewayError ? error : new GatewayError(message(error), RDCleanPathErrorCode.General))
		);
	}

	private async handshake(requestBytes: Uint8Array): Promise<void> {
		const request = decodePdu(requestBytes);
		if (request.proxyAuth !== this.options.authToken) {
			throw new GatewayError('RDCleanPath request has an invalid proxy token', RDCleanPathErrorCode.General);
		}
		let connected = await this.connectTarget(request, keyUsageFallbackHosts.has(this.hostKey(request)));
		if (connected === 'keyUsage') {
			// See RSA_KEY_EXCHANGE: retry once on a fresh connection and remember it for this host.
			this.options.log?.('RDP gateway: server certificate cannot sign; retrying with TLS 1.2 RSA key exchange');
			keyUsageFallbackHosts.add(this.hostKey(request));
			connected = await this.connectTarget(request, true);
		}
		if (!connected || connected === 'keyUsage') return;
		const { target, secure, x224Response } = connected;
		const raw = target.stream;

		if (this.singleSignOn) {
			if (!target.createSecurityContext) {
				throw new GatewayError('Single sign-on is not available for this server', SINGLE_SIGN_ON_FAILED);
			}
			const service = target.vmConnectPayload ? VMCONNECT_SERVICE_CLASS : 'TERMSRV';
			this.options.log?.(`RDP gateway: signing in with the current Windows account (${service}/${target.serverName})`);
			const context = await target.createSecurityContext(`${service}/${target.serverName}`).catch((error) => {
				throw new GatewayError(`Single sign-on failed: ${message(error)}`, SINGLE_SIGN_ON_FAILED);
			});
			try {
				const leaf = secure.getPeerCertificate().raw;
				await authenticateCredSsp(secure, context, subjectPublicKey(new Uint8Array(leaf)));
			} catch (error) {
				throw new GatewayError(`Single sign-on failed: ${message(error)}`, SINGLE_SIGN_ON_FAILED);
			} finally {
				context.dispose();
			}
			if (this.isClosed()) return;
			this.options.log?.('RDP gateway: single sign-on accepted by the server');
		}

		const chain = certificateChain(secure);
		if (!chain.length) throw new GatewayError('The RDP server sent no certificate', RDCleanPathErrorCode.TlsHandshakeFailed);
		const remote = raw instanceof net.Socket && raw.remoteAddress ? `${raw.remoteAddress}:${raw.remotePort}` : target.serverName;

		// Switch to relaying before answering: the client may react (or go away) synchronously.
		this.state = 'relay';
		secure.on('data', (data: Buffer) => {
			this.bytesToClient += data.length;
			this.options.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		});
		this.options.log?.('RDP gateway: relaying');
		secure.on('error', (error) => this.finish(`RDP connection error: ${error.message}`));
		secure.on('close', () => this.finish());
		secure.resume();
		this.options.send(
			encodePdu({
				version: RDCLEANPATH_VERSION,
				x224ConnectionPdu: x224Response,
				serverCertChain: chain,
				serverAddr: remote
			})
		);
		if (!this.isClosed() && this.pending.length) {
			secure.write(this.pending);
			this.pending = Buffer.alloc(0);
		}
	}

	private hostKey(request: RDCleanPathPdu): string {
		return request.destination ?? '';
	}

	/**
	 * One connection attempt: TCP, pre-connection blob or X.224, TLS. Returns `'keyUsage'` when the
	 * server's certificate cannot be used for a signing handshake (the caller retries), `undefined`
	 * when the gateway was closed meanwhile.
	 */
	private async connectTarget(
		request: RDCleanPathPdu,
		rsaKeyExchange: boolean
	): Promise<{ target: GatewayTarget; secure: tls.TLSSocket; x224Response?: Uint8Array } | 'keyUsage' | undefined> {
		let target: GatewayTarget;
		try {
			target = await this.options.open(request);
		} catch (error) {
			throw new GatewayError(`Could not reach the RDP server: ${message(error)}`, RDCleanPathErrorCode.TargetUnreachable);
		}
		if (this.isClosed()) {
			target.dispose();
			return undefined;
		}
		this.target = target;
		const raw = target.stream;

		let x224Response: Uint8Array | undefined;
		if (!request.x224ConnectionPdu) {
			const requested = request.preconnectionBlob ?? '';
			this.singleSignOn = requested.endsWith(PROXY_CREDSSP_MARKER);
			const payload = this.singleSignOn ? requested.slice(0, -PROXY_CREDSSP_MARKER.length) : requested;
			if (!target.vmConnectPayload || payload !== target.vmConnectPayload) {
				throw new GatewayError('VMConnect request does not match the selected virtual machine', RDCleanPathErrorCode.General);
			}
			raw.write(encodePreconnectionBlobV2(target.vmConnectPayload));
		} else {
			if (request.preconnectionBlob) {
				throw new GatewayError('Legacy pre-connection blobs are not supported', RDCleanPathErrorCode.General);
			}
			raw.write(request.x224ConnectionPdu);
			x224Response = await readTpkt(raw);
		}

		this.options.log?.(`RDP gateway: TLS handshake with ${target.serverName}${rsaKeyExchange ? ' (TLS 1.2, RSA key exchange)' : ''}`);
		let secure: tls.TLSSocket;
		try {
			secure = await startTls(raw, target.serverName, { ...(rsaKeyExchange ? RSA_KEY_EXCHANGE : {}), ...this.options.tlsOptions });
		} catch (error) {
			if (!rsaKeyExchange && /KEY_USAGE_BIT_INCORRECT/i.test(message(error))) {
				target.dispose();
				this.target = undefined;
				return 'keyUsage';
			}
			throw error;
		}
		if (this.isClosed()) {
			secure.destroy();
			return undefined;
		}
		this.secure = secure;
		return { target, secure, x224Response };
	}

	/** Not narrowed by TypeScript: `finish()` may run while a handshake step is awaited. */
	private isClosed(): boolean {
		return this.state === 'closed';
	}

	private fail(error: GatewayError): void {
		if (this.state === 'closed') return;
		this.options.log?.(`RDP gateway: ${error.message}`);
		if (this.state !== 'relay') {
			try {
				this.options.send(
					encodePdu({
						version: RDCLEANPATH_VERSION,
						error: { errorCode: error.code, tlsAlertCode: error.tlsAlertCode }
					})
				);
			} catch {
				// Client already gone.
			}
		}
		this.finish(error.message, error.code === SINGLE_SIGN_ON_FAILED);
	}

	private finish(error?: string, singleSignOnFailed = false): void {
		if (this.state === 'closed') return;
		if (this.state === 'relay') {
			this.options.log?.(`RDP gateway: relay closed${error ? ` (${error})` : ''}; ${this.bytesToServer} bytes to the server, ${this.bytesToClient} to the client`);
		}
		this.state = 'closed';
		this.secure?.destroy();
		this.target?.dispose();
		this.options.close(error, singleSignOnFailed ? { singleSignOnFailed } : undefined);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Reads one TPKT-framed PDU (the X.224 Connection Confirm) from the raw, pre-TLS stream. */
function readTpkt(stream: Duplex): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const cleanup = () => {
			stream.off('data', onData);
			stream.off('error', onError);
			stream.off('close', onClose);
			stream.pause();
		};
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			try {
				const length = tpktLength(buffer);
				if (length === undefined) return;
				cleanup();
				if (buffer.length > length) stream.unshift(buffer.subarray(length));
				resolve(buffer.subarray(0, length));
			} catch (error) {
				cleanup();
				reject(error);
			}
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onClose = () => {
			cleanup();
			reject(new Error('The RDP server closed the connection during negotiation'));
		};
		stream.on('data', onData);
		stream.on('error', onError);
		stream.on('close', onClose);
	});
}

function startTls(socket: Duplex, serverName: string, extra?: tls.ConnectionOptions): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const secure = tls.connect({
			socket,
			// RDP servers (Hyper-V included) use self-signed certificates. Identity is verified by
			// CredSSP, which binds the authentication to this certificate's public key.
			rejectUnauthorized: false,
			servername: net.isIP(serverName) ? undefined : serverName,
			...extra
		});
		const onError = (error: Error & { code?: string }) => {
			secure.off('secureConnect', onSecure);
			reject(new GatewayError(`TLS handshake with the RDP server failed: ${error.message}`, RDCleanPathErrorCode.TlsHandshakeFailed));
		};
		const onSecure = () => {
			secure.off('error', onError);
			resolve(secure);
		};
		secure.once('error', onError);
		secure.once('secureConnect', onSecure);
	});
}

/** DER certificates from leaf to the last issuer the server sent. */
function certificateChain(socket: tls.TLSSocket): Uint8Array[] {
	const chain: Uint8Array[] = [];
	const seen = new Set<string>();
	let cert: tls.DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
	while (cert?.raw && !seen.has(cert.fingerprint256)) {
		seen.add(cert.fingerprint256);
		chain.push(new Uint8Array(cert.raw));
		cert = cert.issuerCertificate;
	}
	return chain;
}
