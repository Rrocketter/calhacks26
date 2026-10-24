// Recreates the runtime workspace (~/.ahead/workspace, override AHEAD_WORKSPACE)
// from workspace-seed as a disposable nested git repo.
// The only git init allowed in this project happens here, inside that workspace.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALENDAR_DIR, readCalendar, writeCalendarDir } from './calendar-layout.mjs';

const MARKER = '.ahead-workspace';

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

// Empty or unset means the default. A leading ~ expands to home. Relative values resolve
// against the repo root (same as apps/server/src/env.ts), so checkTarget refuses them.
export function resolveWorkspace(raw, home, repoRoot) {
  const value = raw || path.join(home, '.ahead', 'workspace');
  if (value === '~') return path.resolve(home);
  if (value.startsWith('~/')) return path.resolve(home, value.slice(2));
  return path.resolve(repoRoot, value);
}

// Returns the value of `key` from a dotenv file, or undefined (missing file or key).
// Only that one line is parsed; nothing from the file is ever printed. Last definition wins,
// like node --env-file.
export function readEnvValue(file, key) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let found;
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, '');
    found = v;
  }
  return found;
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

// With IMPORT_GOOGLE=1, real calendar/contacts from pnpm import:google (gitignored
// data/google/) replace the seed copies in the workspace. The calendar comes from
// data/google/calendar/ or, from an older import, data/google/calendar.json.
export function missingGoogle(repoRoot) {
  const dir = path.join(repoRoot, 'data', 'google');
  if (!existsSync(path.join(dir, 'contacts.json'))) return 'IMPORT_GOOGLE=1 but data/google/contacts.json is missing; run: pnpm import:google';
  if (!readCalendar(dir)) return 'IMPORT_GOOGLE=1 but data/google/calendar/ is missing; run: pnpm import:google';
  return null;
}
export function overlayGoogle(repoRoot, target) {
  const dir = path.join(repoRoot, 'data', 'google');
  cpSync(path.join(dir, 'contacts.json'), path.join(target, 'contacts.json'));
  writeCalendarDir(readCalendar(dir), path.join(target, CALENDAR_DIR));
  return ['calendar/', 'contacts.json'];
}

// The seed, with its single calendar.json written as one file per event.
export function copySeed(seed, target) {
  cpSync(seed, target, { recursive: true, filter: (src) => src !== path.join(seed, 'calendar.json') });
  return writeCalendarDir(readCalendar(seed), path.join(target, CALENDAR_DIR));
}

function main() {
  const start = performance.now();
  const repoRoot = canonical(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const home = canonical(os.homedir());
  // Same source as the server (node --env-file=.env): the shell wins, then the repo .env.
  const raw = process.env.AHEAD_WORKSPACE ?? readEnvValue(path.join(repoRoot, '.env'), 'AHEAD_WORKSPACE');
  const target = canonical(resolveWorkspace(raw, os.homedir(), repoRoot));
  const seed = path.join(repoRoot, 'workspace-seed');
  const importGoogle = (process.env.IMPORT_GOOGLE ?? readEnvValue(path.join(repoRoot, '.env'), 'IMPORT_GOOGLE')) === '1';

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
  const missing = importGoogle && missingGoogle(repoRoot);
  if (missing) {
    console.error(`[workspace] ${missing}`);
    process.exit(1);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, MARKER), 'created by scripts/reset-workspace.mjs\n');
  copySeed(seed, target);
  if (importGoogle) console.log(`[workspace] google overlay: ${overlayGoogle(repoRoot, target).join(', ')}`);

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
