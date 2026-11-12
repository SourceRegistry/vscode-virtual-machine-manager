import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalHost } from '../src/host';
import { CLOUD_IMAGES, ensureImage, findImage, imageFileName, imageFileNames, imagesFor, parseChecksums, type CloudImage, type DownloadProgress } from '@vmm/sdk/provisioning';
import { SshHost } from '../src/sshHost';

describe('catalog', () => {
	it('offers each distribution for both architectures with a checksum list next to the image', () => {
		expect(CLOUD_IMAGES.length).toBe(8);
		for (const arch of ['x86_64', 'aarch64'] as const) expect(imagesFor(arch).map((i) => i.id.split('@')[0])).toEqual(['debian-13', 'debian-12', 'ubuntu-24.04', 'ubuntu-22.04']);
		for (const image of CLOUD_IMAGES) {
			expect(image.url).toMatch(/^https:\/\//);
			expect(image.checksumUrl.slice(0, image.checksumUrl.lastIndexOf('/'))).toBe(image.url.slice(0, image.url.lastIndexOf('/')));
			expect(image.url).toContain(image.arch === 'x86_64' ? 'amd64' : 'arm64');
			expect(image.algorithm).toBe(image.checksumUrl.endsWith('SHA512SUMS') ? 'sha512' : 'sha256');
		}
		expect(new Set(CLOUD_IMAGES.map((i) => i.id)).size).toBe(CLOUD_IMAGES.length);
		expect(findImage('debian-12@aarch64')).toMatchObject({ url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2', defaultUser: 'debian' });
		expect(imageFileName(findImage('ubuntu-24.04@x86_64')!)).toBe('ubuntu-24.04-server-cloudimg-amd64.img');
		expect(findImage('nope')).toBeUndefined();
	});
});

describe('parseChecksums', () => {
	const sha256 = 'a'.repeat(64);
	const sha512 = 'b'.repeat(128);
	it('reads the formats the distributions publish', () => {
		expect(parseChecksums(`${sha256} *ubuntu.img\n${'c'.repeat(64)} *other.img\n`, 'ubuntu.img')).toBe(sha256);
		expect(parseChecksums(`${sha512}  debian.qcow2\n`, 'debian.qcow2')).toBe(sha512);
		expect(parseChecksums(`SHA256 (alpine.iso) = ${sha256.toUpperCase()}\n`, 'alpine.iso')).toBe(sha256);
		expect(parseChecksums(`${sha256}  ./sub/dir/file.img\r\n`, 'file.img')).toBe(sha256);
	});
	it('does not guess', () => {
		expect(parseChecksums(`${sha256} *x.img\n`, 'y.img')).toBeUndefined();
		expect(parseChecksums(`${sha256} *x.img.sig\n`, 'x.img')).toBeUndefined();
		expect(parseChecksums('', 'x')).toBeUndefined();
		expect(parseChecksums('garbage line\n12345 x\n', 'x')).toBeUndefined();
	});
});

describe('ensureImage', () => {
	const content = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251));
	const goodHash = createHash('sha256').update(content).digest('hex');
	let server: http.Server;
	let base: string;
	let sums = `${goodHash} *test.img\n`;
	let offline = false;
	const requests: Array<{ url: string; range?: string }> = [];
	let dir: string;
	let n = 0;

	const image = (): CloudImage => ({ id: 'test@x86_64', label: 'Test image', arch: 'x86_64', url: `${base}/test.img`, checksumUrl: `${base}/SHA256SUMS`, algorithm: 'sha256', defaultUser: 'test' });
	const freshDir = () => fs.mkdtempSync(path.join(dir, `d${n++}-`));

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-images-'));
		server = http.createServer((req, res) => {
			requests.push({ url: req.url!, range: req.headers.range });
			if (offline) return res.destroy();
			if (req.url === '/SHA256SUMS') return void res.end(sums);
			if (req.url !== '/test.img') return void res.writeHead(404).end();
			const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
			if (range) {
				const start = Number(range[1]);
				if (start >= content.length) return void res.writeHead(416).end();
				res.writeHead(206, { 'content-length': content.length - start, 'content-range': `bytes ${start}-${content.length - 1}/${content.length}` });
				return void res.end(content.subarray(start));
			}
			res.writeHead(200, { 'content-length': content.length });
			res.end(content);
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('downloads, verifies, reports progress, and leaves a verified file', async () => {
		const target = freshDir();
		const phases: DownloadProgress[] = [];
		const file = await ensureImage(new LocalHost(), image(), target, { onProgress: (p) => phases.push(p) });
		expect(file).toBe(path.join(target, 'test.img'));
		expect(fs.readFileSync(file).equals(content)).toBe(true);
		expect(fs.existsSync(`${file}.part`)).toBe(false);
		expect(phases.map((p) => p.phase)).toEqual(expect.arrayContaining(['checksum', 'download', 'verify']));
		const last = phases.filter((p) => p.phase === 'download').pop()!;
		expect(last).toMatchObject({ done: content.length, total: content.length });
	});

	it('reuses a verified copy without downloading it again', async () => {
		const target = freshDir();
		await ensureImage(new LocalHost(), image(), target);
		requests.length = 0;
		const phases: string[] = [];
		await ensureImage(new LocalHost(), image(), target, { onProgress: (p) => phases.push(p.phase) });
		expect(requests.map((r) => r.url)).toEqual(['/SHA256SUMS']);
		expect(phases).toContain('cached');
	});

	it('downloads again when the published checksum changed', async () => {
		const target = freshDir();
		await ensureImage(new LocalHost(), image(), target);
		const other = Buffer.concat([content, Buffer.from('v2')]);
		const previous = sums;
		sums = `${createHash('sha256').update(other).digest('hex')} *test.img\n`;
		requests.length = 0;
		try {
			// The server still serves the old bytes: the new checksum rejects them, which proves it was fetched and compared.
			await expect(ensureImage(new LocalHost(), image(), target)).rejects.toThrow(/did not match/);
			expect(requests.some((r) => r.url === '/test.img')).toBe(true);
		} finally {
			sums = previous;
		}
	});

	it('continues an interrupted download with a Range request', async () => {
		const target = freshDir();
		fs.writeFileSync(path.join(target, 'test.img.part'), content.subarray(0, 120_000));
		requests.length = 0;
		const file = await ensureImage(new LocalHost(), image(), target);
		expect(requests.find((r) => r.url === '/test.img')?.range).toBe('bytes=120000-');
		expect(fs.readFileSync(file).equals(content)).toBe(true);
	});

	it('starts over when the partial file is longer than the image', async () => {
		const target = freshDir();
		fs.writeFileSync(path.join(target, 'test.img.part'), Buffer.alloc(content.length + 10, 1));
		const file = await ensureImage(new LocalHost(), image(), target);
		expect(fs.readFileSync(file).equals(content)).toBe(true);
	});

	it('refuses a download that does not match its checksum, and deletes it', async () => {
		const target = freshDir();
		const previous = sums;
		sums = `${'0'.repeat(64)} *test.img\n`;
		try {
			await expect(ensureImage(new LocalHost(), image(), target)).rejects.toThrow(/did not match its published SHA256 checksum/);
		} finally {
			sums = previous;
		}
		expect(fs.existsSync(path.join(target, 'test.img'))).toBe(false);
		expect(fs.existsSync(path.join(target, 'test.img.part'))).toBe(false);
	});

	it('says when the checksum list does not mention the image, and when the server fails', async () => {
		const previous = sums;
		sums = `${goodHash} *another.img\n`;
		try {
			await expect(ensureImage(new LocalHost(), image(), freshDir())).rejects.toThrow(/does not mention test\.img/);
		} finally {
			sums = previous;
		}
		await expect(ensureImage(new LocalHost(), { ...image(), url: `${base}/missing.img`, checksumUrl: `${base}/SHA256SUMS` }, freshDir())).rejects.toThrow();
	});

	it('takes the first fallback the checksum list mentions when the usual file is missing from it', async () => {
		const target = freshDir();
		const withFallback = { ...image(), url: `${base}/missing.img`, fallbackUrls: [`${base}/also-missing.img`, `${base}/test.img`] };
		const file = await ensureImage(new LocalHost(), withFallback, target);
		expect(file).toBe(path.join(target, 'test.img'));
		expect(fs.readFileSync(file).equals(content)).toBe(true);
		expect(requests.some((r) => r.url === '/missing.img')).toBe(false);
		// Offline, the verified fallback is still found.
		offline = true;
		try {
			expect(await ensureImage(new LocalHost(), withFallback, target)).toBe(file);
		} finally {
			offline = false;
		}
		const previous = sums;
		sums = `${goodHash} *another.img\n`;
		try {
			await expect(ensureImage(new LocalHost(), withFallback, freshDir())).rejects.toThrow(/missing\.img or also-missing\.img or test\.img/);
		} finally {
			sums = previous;
		}
	});

	it('uses a verified copy when the network is gone, and fails clearly without one', async () => {
		const target = freshDir();
		await ensureImage(new LocalHost(), image(), target);
		offline = true;
		try {
			const phases: string[] = [];
			expect(await ensureImage(new LocalHost(), image(), target, { onProgress: (p) => phases.push(p.phase) })).toBe(path.join(target, 'test.img'));
			expect(phases).toContain('cached');
			await expect(ensureImage(new LocalHost(), image(), freshDir())).rejects.toThrow(/Could not get the checksum/);
		} finally {
			offline = false;
		}
	});

	// The same steps on a "remote" host: curl and the checksum tools run through the stand-in ssh.
	it.skipIf(process.platform === 'win32')('does the transfer on an SSH host', async () => {
		const host = new SshHost({ host: 'lab' }, { command: path.resolve(__dirname, 'fakeSsh.mjs'), anyPlatform: true });
		await host.ping();
		try {
			const target = freshDir();
			const phases: string[] = [];
			const file = await ensureImage(host, image(), target, { onProgress: (p) => phases.push(p.phase) });
			expect(fs.readFileSync(file).equals(content)).toBe(true);
			expect(phases).toEqual(expect.arrayContaining(['download', 'verify']));
			phases.length = 0;
			await ensureImage(host, image(), target, { onProgress: (p) => phases.push(p.phase) });
			expect(phases).toContain('cached');

			const bad = freshDir();
			const previous = sums;
			sums = `${'1'.repeat(64)} *test.img\n`;
			try {
				await expect(ensureImage(host, image(), bad)).rejects.toThrow(/did not match/);
			} finally {
				sums = previous;
			}
			expect(fs.existsSync(path.join(bad, 'test.img.part'))).toBe(false);
		} finally {
			host.dispose();
		}
	}, 60_000);
});

// The real catalog against the real mirrors. Opt-in (needs the internet):  VMM_E2E_CATALOG=1
describe.skipIf(!process.env.VMM_E2E_CATALOG)('the catalog against the real mirrors', () => {
	it.each(CLOUD_IMAGES.map((i) => [i.id, i] as const))('%s is downloadable and listed in its checksum file', async (_id, image) => {
		const sums = await (await fetch(image.checksumUrl)).text();
		// The variant ensureImage takes: the usual file, else the first listed fallback.
		const name = imageFileNames(image).find((f) => parseChecksums(sums, f));
		expect(name, `${image.checksumUrl} lists none of ${imageFileNames(image).join(', ')}`).toBeDefined();
		expect(parseChecksums(sums, name!)).toMatch(image.algorithm === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{128}$/);
		const url = `${image.checksumUrl.slice(0, image.checksumUrl.lastIndexOf('/'))}/${name}`;
		const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
		expect(head.status, url).toBe(200);
		expect(Number(head.headers.get('content-length'))).toBeGreaterThan(100_000_000);
	}, 60_000);
});
