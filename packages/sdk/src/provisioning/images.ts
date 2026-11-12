/**
 * Cloud images VM Manager can download: a small curated catalog, and a downloader that verifies the
 * published checksum, resumes an interrupted transfer and keeps a cache. On an SSH host the transfer runs
 * on the host (`curl`), so the image never passes through this computer.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProviderError } from '../index';

/** A guest architecture, in QEMU's and libvirt's spelling. */
export type Arch = 'x86_64' | 'aarch64';

/**
 * Where an image is kept: this computer, or a host reached over SSH (then `exec` runs there and the
 * transfer never passes through this computer). The QEMU provider's hosts have this shape.
 */
export interface ImageHost {
	readonly remote: boolean;
	readonly path: Pick<typeof path, 'join'>;
	exec(file: string, args: string[], options?: { timeout?: number }): Promise<{ stdout: string }>;
	readFile(file: string): Promise<string>;
	writeFile(file: string, data: string): Promise<void>;
	mkdir(dir: string): Promise<void>;
	rm(target: string): Promise<void>;
	exists(file: string): Promise<boolean>;
}

/** This computer, as an image host (no `exec`: local downloads use `fetch`). */
export const localImageHost: ImageHost = {
	remote: false,
	path,
	exec: () => Promise.reject(new Error('Not available for a local image cache.')),
	readFile: (file) => fs.promises.readFile(file, 'utf8'),
	writeFile: (file, data) => fs.promises.writeFile(file, data),
	mkdir: async (dir) => void (await fs.promises.mkdir(dir, { recursive: true })),
	rm: (target) => fs.promises.rm(target, { force: true }),
	exists: (file) => fs.promises.access(file).then(() => true, () => false)
};

/** A word for a POSIX shell, single-quoted. */
const shq = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

export interface CloudImage {
	/** Stable id, e.g. `debian-12@aarch64`. */
	id: string;
	label: string;
	arch: Arch;
	url: string;
	/** A `SHA256SUMS` / `SHA512SUMS` file listing the image. */
	checksumUrl: string;
	algorithm: 'sha256' | 'sha512';
	/** The account the image creates by default (informational: VM Manager creates its own user). */
	defaultUser: string;
}

function entry(distro: string, label: string, arch: Arch, base: string, file: (a: 'amd64' | 'arm64') => string, sums: string, algorithm: 'sha256' | 'sha512', defaultUser: string): CloudImage {
	const name = arch === 'x86_64' ? file('amd64') : file('arm64');
	return { id: `${distro}@${arch}`, label: `${label} (${arch === 'x86_64' ? 'x86-64' : 'ARM64'})`, arch, url: `${base}/${name}`, checksumUrl: `${base}/${sums}`, algorithm, defaultUser };
}

const DEBIAN = (v: string, code: string) => (arch: Arch) =>
	entry(`debian-${v}`, `Debian ${v} cloud`, arch, `https://cloud.debian.org/images/cloud/${code}/latest`, (a) => `debian-${v}-genericcloud-${a}.qcow2`, 'SHA512SUMS', 'sha512', 'debian');
const UBUNTU = (v: string) => (arch: Arch) =>
	entry(`ubuntu-${v}`, `Ubuntu ${v} LTS cloud`, arch, `https://cloud-images.ubuntu.com/releases/${v}/release`, (a) => `ubuntu-${v}-server-cloudimg-${a}.img`, 'SHA256SUMS', 'sha256', 'ubuntu');

export const CLOUD_IMAGES: readonly CloudImage[] = (['x86_64', 'aarch64'] as const).flatMap((arch) => [DEBIAN('13', 'trixie')(arch), DEBIAN('12', 'bookworm')(arch), UBUNTU('24.04')(arch), UBUNTU('22.04')(arch)]);

export function imagesFor(arch: Arch): CloudImage[] {
	return CLOUD_IMAGES.filter((i) => i.arch === arch);
}

export function findImage(id: string): CloudImage | undefined {
	return CLOUD_IMAGES.find((i) => i.id === id);
}

export function imageFileName(image: CloudImage): string {
	return decodeURIComponent(image.url.slice(image.url.lastIndexOf('/') + 1));
}

/** The hash of `fileName` in a checksum file: `hash  name`, `hash *name`, or BSD `SHA256 (name) = hash`. */
export function parseChecksums(text: string, fileName: string): string | undefined {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const gnu = /^([0-9a-fA-F]{64}|[0-9a-fA-F]{128})\s+\*?(.+)$/.exec(line);
		if (gnu && path.posix.basename(gnu[2]!) === fileName) return gnu[1]!.toLowerCase();
		const bsd = /^SHA(?:256|512) \((.+)\) = ([0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.exec(line);
		if (bsd && path.posix.basename(bsd[1]!) === fileName) return bsd[2]!.toLowerCase();
	}
	return undefined;
}

export interface DownloadProgress {
	phase: 'checksum' | 'download' | 'verify' | 'cached';
	done?: number;
	total?: number;
}

export interface DownloadOptions {
	onProgress?: (progress: DownloadProgress) => void;
	/** Replaces `fetch` (tests). */
	fetchImpl?: typeof fetch;
}

const markerOf = (file: string) => `${file}.verified`;

async function hashFile(file: string, algorithm: string, onProgress?: (done: number) => void): Promise<string> {
	const hash = createHash(algorithm);
	let done = 0;
	for await (const chunk of fs.createReadStream(file)) {
		hash.update(chunk as Buffer);
		done += (chunk as Buffer).length;
		onProgress?.(done);
	}
	return hash.digest('hex');
}

/**
 * Makes sure `image` is in `dir` on `host`, verified against its published checksum, and returns the path.
 * A cached copy is reused while its checksum is still the published one; a damaged transfer is deleted.
 */
export async function ensureImage(host: ImageHost, image: CloudImage, dir: string, options: DownloadOptions = {}): Promise<string> {
	const join = host.path.join;
	const dest = join(dir, imageFileName(image));
	const marker = markerOf(dest);
	await host.mkdir(dir);

	options.onProgress?.({ phase: 'checksum' });
	let expected: string | undefined;
	try {
		const text = host.remote ? (await host.exec('curl', ['-fsSL', '--max-time', '60', image.checksumUrl], { timeout: 90_000 })).stdout : await (await (options.fetchImpl ?? fetch)(image.checksumUrl, { signal: AbortSignal.timeout(60_000) }).then(okOrThrow)).text();
		expected = parseChecksums(text, imageFileName(image));
		if (!expected) throw new ProviderError(`The checksum list at ${image.checksumUrl} does not mention ${imageFileName(image)}.`, 'failed');
	} catch (error) {
		// Offline: a copy that was verified earlier is still good.
		if ((await host.exists(dest)) && (await host.exists(marker))) {
			options.onProgress?.({ phase: 'cached' });
			return dest;
		}
		if (error instanceof ProviderError) throw error;
		throw new ProviderError(`Could not get the checksum of ${image.label}: ${(error as Error).message}`, 'unavailable');
	}

	if ((await host.exists(dest)) && (await host.exists(marker)) && (await host.readFile(marker).catch(() => '')).trim() === expected) {
		options.onProgress?.({ phase: 'cached' });
		return dest;
	}

	const part = `${dest}.part`;
	if (host.remote) await downloadRemote(host, image, part, options);
	else await downloadLocal(image, part, options);

	options.onProgress?.({ phase: 'verify' });
	const actual = host.remote ? await hashRemote(host, part, image.algorithm) : await hashFile(part, image.algorithm, (done) => options.onProgress?.({ phase: 'verify', done }));
	if (actual !== expected) {
		await host.rm(part);
		throw new ProviderError(`${imageFileName(image)} did not match its published ${image.algorithm.toUpperCase()} checksum: the download was damaged or tampered with. It was deleted; try again.`, 'failed');
	}
	await host.rm(dest);
	if (host.remote) await host.exec('mv', ['-f', '--', part, dest]);
	else await fs.promises.rename(part, dest);
	await host.writeFile(marker, `${expected}\n`);
	return dest;
}

function okOrThrow(response: Response): Response {
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	return response;
}

/** Streams to `part`, continuing a partial file with a Range request when the server allows it. */
async function downloadLocal(image: CloudImage, part: string, options: DownloadOptions): Promise<void> {
	const doFetch = options.fetchImpl ?? fetch;
	let have = 0;
	try {
		have = (await fs.promises.stat(part)).size;
	} catch {
		// nothing yet
	}
	let response: Response;
	try {
		response = await doFetch(image.url, { headers: have ? { Range: `bytes=${have}-` } : {} });
		if (response.status === 416) {
			// The partial file is not a prefix of anything the server has: start again.
			await fs.promises.rm(part, { force: true });
			have = 0;
			response = await doFetch(image.url);
		}
		okOrThrow(response);
	} catch (error) {
		throw new ProviderError(`Could not download ${image.label}: ${(error as Error).message}`, 'unavailable');
	}
	const resumed = response.status === 206 && have > 0;
	if (!resumed) have = 0;
	const length = Number(response.headers.get('content-length'));
	const total = Number.isFinite(length) && length > 0 ? have + length : undefined;
	const handle = await fs.promises.open(part, resumed ? 'a' : 'w');
	try {
		let done = have;
		options.onProgress?.({ phase: 'download', done, total });
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			await handle.write(chunk);
			done += chunk.length;
			options.onProgress?.({ phase: 'download', done, total });
		}
	} catch (error) {
		throw new ProviderError(`The download of ${image.label} was interrupted (${(error as Error).message}). Run it again to continue where it stopped.`, 'unavailable');
	} finally {
		await handle.close();
	}
}

async function downloadRemote(host: ImageHost, image: CloudImage, part: string, options: DownloadOptions): Promise<void> {
	let total: number | undefined;
	try {
		const head = (await host.exec('curl', ['-sIL', '--max-time', '60', image.url], { timeout: 90_000 })).stdout;
		const lengths = [...head.matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
		total = lengths.length ? lengths[lengths.length - 1] : undefined;
	} catch {
		// unknown size: progress without a percentage
	}
	let finished = false;
	const poll = (async () => {
		while (!finished) {
			await new Promise((r) => setTimeout(r, 2000));
			if (finished) return;
			const size = Number((await host.exec('sh', ['-c', `wc -c < ${shq(part)} 2>/dev/null || echo 0`], { timeout: 30_000 }).catch(() => ({ stdout: '0' }))).stdout.trim());
			if (Number.isFinite(size)) options.onProgress?.({ phase: 'download', done: size, total });
		}
	})();
	try {
		options.onProgress?.({ phase: 'download', done: 0, total });
		await host.exec('curl', ['-fsSL', '-C', '-', '--retry', '3', '--retry-delay', '2', '-o', part, image.url], { timeout: 3 * 3600_000 });
	} catch (error) {
		throw new ProviderError(`The host could not download ${image.label}: ${(error as Error).message}. Run it again to continue where it stopped.`, 'unavailable');
	} finally {
		finished = true;
		await poll;
	}
}

async function hashRemote(host: ImageHost, file: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
	const bits = algorithm === 'sha256' ? '256' : '512';
	const { stdout } = await host.exec('sh', ['-c', `sha${bits}sum ${shq(file)} 2>/dev/null || shasum -a ${bits} ${shq(file)}`], { timeout: 30 * 60_000 });
	return stdout.trim().split(/\s+/)[0]!.toLowerCase();
}
