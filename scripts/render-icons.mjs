// Renders the Marketplace icons (256×256 PNG; the Marketplace does not accept SVG icons) from
// media/marketplace/icon.svg (512×512). Provider icons are the same artwork with a badge holding the
// platform's logo (media/marketplace/<provider>.svg, see BADGES), so the extensions read as one
// family. Run after changing the artwork or adding a provider: `node scripts/render-icons.mjs`.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packages, root } from './packages.mjs';

const artwork = (name) => readFileSync(path.join(root, 'media', 'marketplace', name), 'utf8');
const base = artwork('icon.svg');

/** Badge in the bottom-right corner (512 coordinates of icon.svg); the ring in the tile colour separates it. */
const BADGE = { cx: 418, cy: 418, r: 80, ring: 12, ringColor: '#101B2E' };

/**
 * A white badge with a logo nested as its own SVG, so the logo's ids and coordinates stay separate.
 * `scale` is the logo's box relative to the badge radius: keep its corners inside the badge where the
 * artwork reaches them.
 */
function badge(file, scale) {
	const source = artwork(file);
	const open = /<svg\b[^>]*>/.exec(source)?.[0];
	// Editor metadata (Inkscape) needs namespaces declared on the outer element, which nesting drops: it is not artwork.
	const inner = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(source)?.[1]
		?.replace(/<sodipodi:namedview\b[\s\S]*?<\/sodipodi:namedview>|<sodipodi:namedview\b[^>]*\/>|<metadata\b[\s\S]*?<\/metadata>/g, '')
		.replace(/\s(?:inkscape|sodipodi):[\w-]+="[^"]*"/g, '');
	if (!open || inner === undefined) throw new Error(`No SVG content in media/marketplace/${file}`);
	const viewBox =
		/viewBox="([^"]+)"/.exec(open)?.[1] ??
		`0 0 ${/width="([\d.]+)"/.exec(open)?.[1] ?? 64} ${/height="([\d.]+)"/.exec(open)?.[1] ?? 64}`;
	const size = BADGE.r * scale;
	return `
  <circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.r + BADGE.ring}" fill="${BADGE.ringColor}"/>
  <circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.r}" fill="#ffffff"/>
  <svg xmlns:xlink="http://www.w3.org/1999/xlink" x="${BADGE.cx - size / 2}" y="${BADGE.cy - size / 2}" width="${size}" height="${size}" viewBox="${viewBox}">${inner}</svg>`;
}

const withBadge = (file, scale) => base.replace(/<\/svg>\s*$/, `${badge(file, scale)}\n</svg>\n`);

/**
 * The badge artwork of every provider, keyed by its directory in extensions/. A new provider must be
 * added here (the run fails otherwise, and so does test/extensions.test.ts): its logo goes to
 * media/marketplace/<id>.svg.
 */
export const BADGES = {
	hyperv: { file: 'hyperv.svg', scale: 1.4 },
	// The QEMU tail reaches the corner of its box: 1.3 keeps the diagonal inside the badge.
	qemu: { file: 'qemu.svg', scale: 1.3 },
	proxmox: { file: 'proxmox.svg', scale: 1.4 },
	// The official libvirt square logo (https://libvirt.org/logos/): its tin is rotated, so it needs the same room as the QEMU tail.
	libvirt: { file: 'libvirt.svg', scale: 1.75 },
	// The Nutanix "X" mark from Simple Icons (CC0, https://simpleicons.org/?q=nutanix) in its brand blue.
	nutanix: { file: 'nutanix.svg', scale: 1.2 }
};

function icons() {
	return packages.map((p) => {
		const out = path.relative(root, path.join(p.dir, 'media', 'icon.png'));
		if (p.id === 'core') return { out, svg: base };
		const badge = BADGES[p.id];
		if (!badge) throw new Error(`No badge artwork for extensions/${p.id}: add it to BADGES in scripts/render-icons.mjs`);
		return { out, svg: withBadge(badge.file, badge.scale) };
	});
}

async function render() {
	const { Resvg } = await import('@resvg/resvg-js');
	for (const { out, svg } of icons()) {
		const png = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
		writeFileSync(path.join(root, out), png);
		console.log(`${out} (${png.length} bytes)`);
	}
}

// Importable (test/extensions.test.ts reads BADGES) without rendering.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await render();
