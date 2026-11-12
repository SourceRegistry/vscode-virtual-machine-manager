/**
 * cloud-init "NoCloud" data for a new VM: `user-data` and `meta-data`, and the SHA-512 password hash
 * cloud-init expects. Pure and unit tested.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface CloudInitOptions {
	hostname: string;
	user: string;
	/** Public keys for the user (one per entry). */
	sshKeys: string[];
	/** A `$6$…` hash (see `sha512Crypt`); empty = no password login. */
	passwordHash?: string;
	/** Install and start qemu-guest-agent on first boot (needs the guest to reach a package mirror). */
	installAgent: boolean;
	/** Replaces the generated `user-data` entirely when given. */
	customUserData?: string;
	/** Changes when the machine should be set up again (a new VM, not a restart). */
	instanceId: string;
}

const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOSTNAME = /^(?=.{1,63}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SSH_KEY = /^(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/;

export function validCloudUser(user: string): boolean {
	return USER.test(user) && user !== 'root';
}

export function validHostname(name: string): boolean {
	return HOSTNAME.test(name);
}

export function validSshPublicKey(key: string): boolean {
	return SSH_KEY.test(key.trim());
}

/** A VM name as a host name: lowercase letters, digits and hyphens. */
export function hostnameFor(vmName: string): string {
	const slug = vmName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 63)
		.replace(/-+$/g, '');
	return slug || 'vm';
}

/** A YAML double-quoted scalar. JSON strings are valid YAML. */
const q = (text: string): string => JSON.stringify(text);

/** First problem with the options, or `undefined`. */
export function cloudInitProblem(o: Pick<CloudInitOptions, 'hostname' | 'user' | 'sshKeys' | 'passwordHash'>): string | undefined {
	if (!validHostname(o.hostname)) return `"${o.hostname}" is not a valid host name (letters, digits and hyphens).`;
	if (!validCloudUser(o.user)) return `"${o.user}" is not a valid user name: lowercase letters, digits, _ and -, not root.`;
	for (const key of o.sshKeys) if (!validSshPublicKey(key)) return 'The SSH key is not a public key (it should start with ssh-ed25519, ssh-rsa or ecdsa-…).';
	if (!o.sshKeys.length && !o.passwordHash) return 'Give an SSH public key or a password, or there is no way to sign in to the machine.';
	if (o.passwordHash && !/^\$6\$[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$/.test(o.passwordHash)) return 'The password hash is not a SHA-512 crypt hash.';
	return undefined;
}

export function userData(o: CloudInitOptions): string {
	if (o.customUserData?.trim()) return o.customUserData.endsWith('\n') ? o.customUserData : `${o.customUserData}\n`;
	const lines = ['#cloud-config', `hostname: ${q(o.hostname)}`, 'manage_etc_hosts: true', 'users:', `  - name: ${q(o.user)}`, `    gecos: ${q(o.user)}`, '    shell: /bin/bash', `    sudo: ${q('ALL=(ALL) NOPASSWD:ALL')}`];
	lines.push(`    lock_passwd: ${o.passwordHash ? 'false' : 'true'}`);
	if (o.passwordHash) lines.push(`    passwd: ${q(o.passwordHash)}`);
	if (o.sshKeys.length) {
		lines.push('    ssh_authorized_keys:');
		for (const key of o.sshKeys) lines.push(`      - ${q(key.trim())}`);
	}
	lines.push(`ssh_pwauth: ${o.passwordHash ? 'true' : 'false'}`);
	if (o.installAgent) {
		lines.push('package_update: true', 'packages:', '  - qemu-guest-agent', 'runcmd:', `  - [sh, -c, ${q('systemctl enable --now qemu-guest-agent || systemctl start qemu-guest-agent || true')}]`);
	}
	return `${lines.join('\n')}\n`;
}

export function metaData(o: Pick<CloudInitOptions, 'instanceId' | 'hostname'>): string {
	return `instance-id: ${q(o.instanceId)}\nlocal-hostname: ${q(o.hostname)}\n`;
}

const ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function b64(b2: number, b1: number, b0: number, count: number): string {
	let w = (b2 << 16) | (b1 << 8) | b0;
	let out = '';
	for (let i = 0; i < count; i++) {
		out += ALPHABET[w & 0x3f];
		w >>= 6;
	}
	return out;
}

const sha512 = (...parts: Buffer[]): Buffer => {
	const hash = createHash('sha512');
	for (const part of parts) hash.update(part);
	return hash.digest();
};

/** Repeats `digest` to exactly `length` bytes. */
function stretch(digest: Buffer, length: number): Buffer {
	const out = Buffer.alloc(length);
	for (let i = 0; i < length; i++) out[i] = digest[i % digest.length]!;
	return out;
}

/** `crypt(3)` SHA-512 (`$6$`), 5000 rounds, as in Drepper's specification. The salt is random when not given. */
export function sha512Crypt(password: string, salt: string = randomBytes(12).toString('base64').replace(/[^./0-9A-Za-z]/g, '.').slice(0, 16)): string {
	const pw = Buffer.from(password, 'utf8');
	const s = Buffer.from(salt.slice(0, 16), 'ascii');
	const digestB = sha512(pw, s, pw);
	const a: Buffer[] = [pw, s, stretch(digestB, pw.length)];
	for (let n = pw.length; n > 0; n >>= 1) a.push(n & 1 ? digestB : pw);
	let digestA = sha512(...a);
	const p = stretch(sha512(...Array.from({ length: pw.length }, () => pw)), pw.length);
	const sSeq = stretch(sha512(...Array.from({ length: 16 + digestA[0]! }, () => s)), s.length);
	for (let i = 0; i < 5000; i++) {
		digestA = sha512(i & 1 ? p : digestA, ...(i % 3 ? [sSeq] : []), ...(i % 7 ? [p] : []), i & 1 ? digestA : p);
	}
	const d = digestA;
	const order = [
		[0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10],
		[53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41]
	] as const;
	let out = '';
	for (const [x, y, z] of order) out += b64(d[x]!, d[y]!, d[z]!, 4);
	out += b64(0, 0, d[63]!, 2);
	return `$6$${s.toString('ascii')}$${out}`;
}
