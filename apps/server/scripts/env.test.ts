// WORKSPACE_DIR resolution in src/env.ts: a relative AHEAD_WORKSPACE resolves against REPO_ROOT,
// not the process cwd (pnpm --filter runs in apps/server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.AHEAD_WORKSPACE = '../ahead-env-test-ws';
const { REPO_ROOT, WORKSPACE_DIR } = await import('../src/env.js');

test('relative AHEAD_WORKSPACE resolves against REPO_ROOT', () => {
  assert.notEqual(process.cwd(), REPO_ROOT);
  const expected = path.join(fs.realpathSync.native(path.dirname(REPO_ROOT)), 'ahead-env-test-ws');
  assert.equal(WORKSPACE_DIR, expected);
});
