// Recreates var/workspace from workspace-seed as a disposable nested git repo.
// The only git init allowed in this project happens here, inside var/workspace.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const start = performance.now();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repoRoot, 'var', 'workspace');
const seed = path.join(repoRoot, 'workspace-seed');

if (!existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))) {
  throw new Error(`repoRoot looks wrong (no pnpm-workspace.yaml): ${repoRoot}`);
}
if (target !== path.join(repoRoot, 'var', 'workspace')) {
  throw new Error(`refusing to remove unexpected path: ${target}`);
}
if (!existsSync(seed)) throw new Error(`missing seed dir: ${seed}`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(seed, target, { recursive: true });

const git = (...args) => execFileSync('git', ['-C', target, ...args], { stdio: 'pipe' });
git('init', '-b', 'main');
git('add', '-A');
git(
  '-c', 'user.name=ahead',
  '-c', 'user.email=ahead@localhost',
  '-c', 'commit.gpgsign=false',
  'commit', '--no-verify', '-m', 'seed',
);

console.log(`[workspace] reset in ${(performance.now() - start).toFixed(0)}ms`);
