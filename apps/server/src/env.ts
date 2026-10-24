import { fileURLToPath } from 'node:url';
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
export const WORKSPACE_DIR = path.join(REPO_ROOT, 'var', 'workspace');
