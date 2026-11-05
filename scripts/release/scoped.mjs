// semantic-release plugin: analyses and describes only the commits that belong to one package.
//
// semantic-release looks at every commit since the package's last tag. In this monorepo most of
// them belong to other packages, so this keeps the commits that touched the package's paths and
// hands those to the regular commit analyzer and release notes generator.
import { execFileSync } from 'node:child_process';
import { analyzeCommits as analyze } from '@semantic-release/commit-analyzer';
import { generateNotes as notes } from '@semantic-release/release-notes-generator';
import { touchesPackage } from '../packages.mjs';

function filesOf(hash, cwd) {
	// -m --first-parent: a merge commit lists what the merge brought into the branch.
	const out = execFileSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', hash], {
		cwd,
		encoding: 'utf8'
	});
	return out.split('\n').filter(Boolean);
}

function scoped(pluginConfig, context) {
	const commits = context.commits.filter((commit) => touchesPackage(filesOf(commit.hash, context.cwd), pluginConfig));
	context.logger.log('%d of %d commits belong to this package', commits.length, context.commits.length);
	return { ...context, commits };
}

export const analyzeCommits = (pluginConfig, context) => analyze(pluginConfig.analyzer ?? {}, scoped(pluginConfig, context));
export const generateNotes = (pluginConfig, context) => notes(pluginConfig.notes ?? {}, scoped(pluginConfig, context));
