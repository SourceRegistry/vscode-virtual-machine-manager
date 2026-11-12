/** The "from a cloud image" half of the create form, and the local defaults it offers. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FieldSchema } from '../index';
import { validCloudUser, validSshPublicKey } from './cloudInit';
import { imageFileName, imagesFor, type Arch } from './images';

export const SOURCE_ISO = { key: 'source', equals: 'iso', default: 'iso' } as const;
const SOURCE_CLOUD = { key: 'source', equals: 'cloud' } as const;

/** The first public key of this computer's `~/.ssh` (ed25519 before the others), or empty. */
export function localSshPublicKey(home = os.homedir()): string {
	for (const name of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
		try {
			const key = fs.readFileSync(path.join(home, '.ssh', name), 'utf8').trim().split('\n')[0]!.trim();
			if (validSshPublicKey(key)) return key;
		} catch {
			// not there
		}
	}
	return '';
}

/** The user name of this computer as a guest account name, when it is a valid one. */
export function defaultCloudUser(name: string = os.userInfo().username): string {
	const user = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
	return validCloudUser(user) ? user : 'user';
}

/** One public key per non-empty line. */
export function parseKeys(text: string | undefined): string[] {
	return (text ?? '')
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
}

export interface CloudSchemaOptions {
	installed: Arch[];
	/** Image paths are on another computer. */
	remote: boolean;
	/** File names in the image cache that are verified downloads. */
	cached: ReadonlySet<string>;
}

/** The fields shown when the source is a cloud image. */
export function cloudFields(o: CloudSchemaOptions): FieldSchema[] {
	const images = o.installed.flatMap((arch) => imagesFor(arch));
	return [
		{
			key: 'cloudImage',
			label: 'Cloud image',
			type: 'select',
			required: true,
			default: images[0]?.id,
			showWhen: SOURCE_CLOUD,
			options: [
				...images.map((i) => ({ value: i.id, label: i.label, description: o.cached.has(imageFileName(i)) ? 'Downloaded' : 'Downloaded when you create the machine; checksum verified' })),
				{ value: 'custom', label: 'A disk image file…', description: o.remote ? 'A path on the host' : 'A cloud-init capable qcow2, img or raw file' }
			],
			description: 'Ready-made disks from the distributions: no installer, ready in a minute.'
		},
		{ key: 'cloudImageFile', label: 'Image file', type: 'file', required: true, remotePath: o.remote, showWhen: { key: 'cloudImage', equals: 'custom' }, filters: { 'Disk images': ['qcow2', 'img', 'raw'] } },
		{ key: 'ciUser', label: 'User', type: 'text', required: true, default: defaultCloudUser(), showWhen: SOURCE_CLOUD, description: 'The account to create (with passwordless sudo). Lowercase letters, digits, _ and -.' },
		{
			key: 'ciSshKey',
			label: 'SSH public key',
			type: 'text',
			default: localSshPublicKey() || undefined,
			showWhen: SOURCE_CLOUD,
			placeholder: 'ssh-ed25519 AAAA…',
			description: 'Lets you sign in without a password. Filled from ~/.ssh when there is a key. Empty: set a password.'
		},
		{ key: 'ciPassword', label: 'Password', type: 'password', showWhen: SOURCE_CLOUD, description: 'Optional when there is a key. It is stored as a hash in the machine\'s seed disk, never as text.' },
		{ key: 'ciAgent', label: 'Install the QEMU guest agent', type: 'checkbox', default: true, showWhen: SOURCE_CLOUD, advanced: true, description: 'Shows the IP address and allows a clean shutdown. The machine needs internet access on first boot.' },
		{ key: 'ciHostname', label: 'Host name', type: 'text', showWhen: SOURCE_CLOUD, advanced: true, placeholder: 'From the name', description: 'Letters, digits and hyphens. Empty: the machine name.' },
		{ key: 'ciUserData', label: 'Custom user-data', type: 'textarea', showWhen: SOURCE_CLOUD, advanced: true, description: 'A complete #cloud-config that replaces the generated one (then the user, key and password above are not used).' }
	];
}

