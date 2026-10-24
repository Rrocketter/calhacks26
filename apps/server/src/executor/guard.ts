// Workspace guard for the Droid executor. Pure path and tool-name checks, ported from
// scripts/spike-droid.ts and parametrized by the workspace root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Watchdog: any tool_call whose name is not in this set aborts the turn.
export const TOOL_ALLOWLIST: ReadonlySet<string> = new Set(['Read', 'Create', 'Edit', 'ApplyPatch', 'TodoWrite', 'ToolSearch']);

// Env for the droid CLI child. @factory/droid-sdk@0.10.0 spawns with {...process.env, ...env}
// (dist/node.mjs ProcessManager, sanitizeSpawnEnv is a no-op), so passing an allowlist alone
// would still forward every other key (CARTESIA/MOSS/ANTHROPIC keys under --env-file). Every
// non-allowlisted key is set to undefined, which child_process.spawn drops from the child env.
// The SDK then adds FACTORY_API_KEY and FACTORY_UPSTREAM_* itself.
export const DROID_ENV_ALLOWLIST = ['FACTORY_API_KEY', 'PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'SHELL'] as const;
export function droidChildEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(src)) env[key] = undefined;
  for (const key of DROID_ENV_ALLOWLIST) if (src[key] !== undefined) env[key] = src[key];
  // The SDK type says Record<string, string>; undefined values are intentional (see above).
  return env as Record<string, string>;
}

function expand(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

// Walk the path one component at a time with lstat. Symlinks are followed with realpath; a
// dangling symlink returns null (deny). Components that do not exist yet are joined lexically.
function resolveFrom(base: string, p: string): string | null {
  const abs = path.resolve(base, expand(p));
  const parts = abs.split(path.sep).filter(Boolean);
  let cur = path.parse(abs).root;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]!);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch {
      return path.join(next, ...parts.slice(i + 1));
    }
    if (st.isSymbolicLink()) {
      try {
        cur = fs.realpathSync.native(next);
      } catch {
        return null;
      }
    } else {
      cur = next;
    }
  }
  try {
    return fs.realpathSync.native(cur);
  } catch {
    return cur;
  }
}

// Paths named inside an ApplyPatch body (V4A "*** Add File:" style and unified diff headers).
export function patchPaths(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  const out: string[] = [];
  const re = /^(?:\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: |--- (?:a\/)?|\+\+\+ (?:b\/)?)(.+)$/gm;
  for (const m of body.matchAll(re)) {
    const p = m[1]!.trim();
    if (p && p !== '/dev/null') out.push(p);
  }
  return out;
}

const CONTENT_KEYS = new Set(['content', 'old_str', 'new_str', 'old_string', 'new_string', 'text', 'patch', 'input', 'description', 'todos']);
const PATH_KEYS = ['file_path', 'filePath', 'path', 'paths', 'directory_path', 'dir', 'folder', 'cwd', 'pattern', 'glob', 'target', 'notebook_path'];

// Every path-like value in a tool input. Glob patterns contribute their non-glob prefix.
export function inputPaths(input: unknown): { keys: string[]; paths: string[] } {
  const keys: string[] = [];
  const paths: string[] = [];
  if (!input || typeof input !== 'object') return { keys, paths };
  const o = input as Record<string, unknown>;
  const add = (v: string, key: string): void => {
    const globAt = v.search(/[*?[{]/);
    const base = globAt === -1 ? v : v.slice(0, globAt);
    if (key === 'pattern' && globAt === -1 && !v.includes('/')) return; // plain regex for Grep
    paths.push(base === '' ? '.' : base);
  };
  for (const k of PATH_KEYS) {
    const v = o[k];
    if (typeof v === 'string') {
      keys.push(k);
      add(v, k);
    } else if (Array.isArray(v)) {
      keys.push(k);
      for (const x of v) if (typeof x === 'string') add(x, k);
    }
  }
  // Any other string value that looks like a path (contains '/' or a '..' segment) counts too.
  // File-content keys are skipped so text in Create/Edit bodies is not mistaken for a path.
  for (const [k, v] of Object.entries(o)) {
    if (PATH_KEYS.includes(k) || CONTENT_KEYS.has(k) || typeof v !== 'string') continue;
    if (v.includes('/') || /(^|[\\/])\.\.([\\/]|$)/.test(v) || v.startsWith('~')) {
      keys.push(k);
      paths.push(v);
    }
  }
  return { keys, paths };
}

export type GuardDenial = { reason: 'tool-not-allowed' | 'outside-workspace'; path: string | null };

export interface Guard {
  resolveStrict(p: string): string | null;
  inside(p: string): boolean;
  checkToolCall(name: string, input: unknown): GuardDenial | null;
}

export function makeGuard(root: string): Guard {
  const rootReal = resolveFrom(root, root) ?? path.resolve(root);
  const resolveStrict = (p: string): string | null => resolveFrom(rootReal, p);
  // Inside means strictly below the workspace root and not under .git/.
  const inside = (p: string): boolean => {
    const real = resolveStrict(p);
    if (real === null) return false;
    const rel = path.relative(rootReal.toLowerCase(), real.toLowerCase());
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return rel.split(path.sep)[0] !== '.git';
  };
  const checkToolCall = (name: string, input: unknown): GuardDenial | null => {
    if (!TOOL_ALLOWLIST.has(name)) return { reason: 'tool-not-allowed', path: null };
    const outside = inputPaths(input).paths.find((p) => !inside(p));
    return outside === undefined ? null : { reason: 'outside-workspace', path: outside };
  };
  return { resolveStrict, inside, checkToolCall };
}

// The workspace must not contain the repo or live inside it (Droid's Read tools bypass the permission handler).
export function assertWorkspaceLocation(workspace: string, repoRoot: string): void {
  const canon = (p: string): string => (resolveFrom(p, p) ?? path.resolve(p)).toLowerCase();
  const contains = (outer: string, inner: string): boolean => {
    const rel = path.relative(outer, inner);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const w = canon(workspace);
  const r = canon(repoRoot);
  if (contains(w, r) || contains(r, w)) throw new Error('workspace must be outside the repo');
}
