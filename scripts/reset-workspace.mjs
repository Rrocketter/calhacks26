// Recreates the runtime workspace (~/.ahead/workspace, override AHEAD_WORKSPACE)
// from workspace-seed as a disposable nested git repo.
// The only git init allowed in this project happens here, inside that workspace.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '.ahead-workspace';

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

// Empty or unset means the default. A leading ~ expands to home.
export function resolveWorkspace(raw, home) {
  const value = raw || path.join(home, '.ahead', 'workspace');
  if (value === '~') return path.resolve(home);
  if (value.startsWith('~/')) return path.resolve(home, value.slice(2));
  return path.resolve(value);
}

// Pure path guard. Returns a refusal reason, or null if the path is acceptable.
export function checkTarget(target, { repoRoot, home }) {
  if (!path.isAbsolute(target)) return 'path is not absolute';
  if (target === path.parse(target).root) return 'path is the filesystem root';
  if (target === home) return 'path is the home directory';
  if (target === repoRoot) return 'path is the repo root';
  if (isInside(target, repoRoot)) return 'path is inside the repo';
  if (isInside(repoRoot, target)) return 'path is an ancestor of the repo';
  if (isInside(home, target)) return 'path is an ancestor of the home directory';
  return null;
}

// Resolve symlinks and on-disk case for the deepest existing ancestor, so
// /Users/x/developer and /Users/x/Developer (case-insensitive APFS) compare equal.
export function canonical(p) {
  const rest = [];
  let cur = path.resolve(p);
  while (!existsSync(cur)) {
    rest.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(realpathSync.native(cur), ...rest);
}

function main() {
  const start = performance.now();
  const repoRoot = canonical(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const home = canonical(os.homedir());
  const target = canonical(resolveWorkspace(process.env.AHEAD_WORKSPACE, os.homedir()));
  const seed = path.join(repoRoot, 'workspace-seed');

  const refuse = (reason) => {
    console.error(`[workspace] refusing to delete ${target}: ${reason}`);
    process.exit(1);
  };

  if (!existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))) {
    throw new Error(`repoRoot looks wrong (no pnpm-workspace.yaml): ${repoRoot}`);
  }
  if (!existsSync(seed)) throw new Error(`missing seed dir: ${seed}`);

  const ctx = { repoRoot, home };
  let reason = checkTarget(target, ctx);
  if (!reason && existsSync(target) && !existsSync(path.join(target, MARKER))) {
    reason = `exists but has no ${MARKER} marker`;
  }
  if (reason) refuse(reason);

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, MARKER), 'created by scripts/reset-workspace.mjs\n');
  cpSync(seed, target, { recursive: true });

  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) =>
    execFileSync('git', ['-C', target, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe', env });

  git('init', '-b', 'main');
  mkdirSync(path.join(target, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(target, '.git', 'info', 'exclude'), `${MARKER}\n`, { flag: 'a' });
  git('add', '-A');
  git(
    '-c', 'user.name=ahead',
    '-c', 'user.email=ahead@localhost',
    '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-m', 'seed',
  );

  console.log(`[workspace] reset ${target} in ${(performance.now() - start).toFixed(0)}ms`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
