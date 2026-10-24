import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('missing env ' + name);
  return value;
}

// This file lives at apps/server/src (or apps/server/dist/src once built).
const here = path.dirname(fileURLToPath(import.meta.url));
const up = path.basename(path.dirname(here)) === 'dist' ? 4 : 3;
export const REPO_ROOT = path.resolve(here, ...Array<string>(up).fill('..'));
// Outside the repo on purpose: Droid's Read/LS tools bypass the permission handler.
export const WORKSPACE_DIR = path.resolve(process.env.AHEAD_WORKSPACE ?? path.join(os.homedir(), '.ahead', 'workspace'));
