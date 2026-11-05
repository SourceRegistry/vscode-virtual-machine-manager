// semantic-release configuration for ONE package. scripts/release.mjs runs semantic-release once per
// package in scripts/packages.mjs and selects it through RELEASE_PACKAGE.
import { findPackage } from './scripts/packages.mjs';

const pkg = findPackage(process.env.RELEASE_PACKAGE ?? 'core');
const manifest = pkg.id === 'core' ? 'package.json' : `extensions/${pkg.id}/package.json`;
const select = pkg.id === 'core' ? '' : ` -w extensions/${pkg.id}`;

export default {
	branches: ['main'],
	tagFormat: pkg.tagFormat,
	plugins: [
		['./scripts/release/scoped.mjs', { paths: pkg.paths, exclude: pkg.exclude }],
		['@semantic-release/changelog', { changelogFile: pkg.changelog, changelogTitle: '# Changelog' }],
		[
			'@semantic-release/exec',
			{
				prepareCmd: `npm version \${nextRelease.version}${select} --no-git-tag-version --allow-same-version && npm run build && node scripts/package.mjs ${pkg.id}`,
				publishCmd: `node scripts/publish.mjs ${pkg.id}`
			}
		],
		[
			'@semantic-release/git',
			{
				assets: [pkg.changelog, manifest, 'package-lock.json'],
				message: `chore(release): ${pkg.name} \${nextRelease.version} [skip ci]\n\n\${nextRelease.notes}`
			}
		],
		['@semantic-release/github', { assets: [{ path: `out/${pkg.name}-\${nextRelease.version}.vsix` }] }]
	]
};
