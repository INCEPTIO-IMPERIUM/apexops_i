// Prettier on the files this branch changes, not the whole repository: most of
// the tree predates the formatter, and reformatting it all at once would bury
// every real change in the history. A file joins the standard when it is next
// edited.
//
//   npm run format:check                       # against origin/main
//   npm run format:changed                     # fix them
//   FORMAT_BASE=<sha> npm run format:check     # CI passes the PR's base
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const base = process.env.FORMAT_BASE || 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
// Against the merge base, including uncommitted and new files when run locally.
const mergeBase = git('merge-base', base, 'HEAD').trim();
const files = [
    ...new Set(
        [git('diff', '--name-only', '--diff-filter=ACMR', mergeBase), git('ls-files', '--others', '--exclude-standard')]
            .join('\n')
            .split('\n')
            .filter((f) => f && existsSync(f)),
    ),
];

if (!files.length) {
    console.log('No changed files to check.');
    process.exit(0);
}

const prettier = createRequire(import.meta.url).resolve('prettier/bin/prettier.cjs');
const mode = process.argv.includes('--write') ? '--write' : '--check';
try {
    // Arguments are passed as an array: a file name is never read by a shell.
    execFileSync(process.execPath, [prettier, mode, '--ignore-unknown', ...files], { stdio: 'inherit' });
} catch {
    console.error('\nRun `npm run format:changed` and commit the result.');
    process.exit(1);
}
