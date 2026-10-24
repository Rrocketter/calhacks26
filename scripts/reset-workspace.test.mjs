import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonical, checkTarget, resolveWorkspace } from './reset-workspace.mjs';

const repoRoot = canonical(path.resolve(import.meta.dirname, '..'));
const home = canonical(os.homedir());
const ctx = { repoRoot, home };
const check = (p) => checkTarget(canonical(p), ctx);

test('refuses home, root, repo, inside repo, ancestors', () => {
  assert.match(check(home), /home directory/);
  assert.match(check('/'), /root/);
  assert.match(check(repoRoot), /repo root/);
  assert.match(check(path.join(repoRoot, 'var', 'x')), /inside the repo/);
  assert.match(check(path.dirname(repoRoot)), /ancestor of the repo/);
  assert.match(check(path.dirname(home)), /ancestor/);
});

test('refuses repo case-variant', () => {
  const flipped = repoRoot.replace(/[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const variant = flipped.replace(/\/([A-Za-z])/g, (_, c) => '/' + c.toLowerCase());
  assert.match(check(path.join(variant, 'var', 'x')), /inside the repo/);
});

test('refuses <repo>/..ws', () => {
  assert.match(check(path.join(repoRoot, '..ws')), /inside the repo/);
});

test('rejects relative paths in checkTarget', () => {
  assert.match(checkTarget('rel/x', ctx), /not absolute/);
});

test('empty or unset resolves to default', () => {
  const dflt = path.join(home, '.ahead', 'workspace');
  assert.equal(resolveWorkspace('', home), dflt);
  assert.equal(resolveWorkspace(undefined, home), dflt);
});

test('expands leading ~', () => {
  assert.equal(resolveWorkspace('~/x', home), path.join(home, 'x'));
  assert.equal(resolveWorkspace('~', home), home);
});

test('accepts default and scratch paths', () => {
  assert.equal(check(path.join(home, '.ahead', 'workspace')), null);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ahead-test-'));
  assert.equal(check(path.join(scratch, 'ws')), null);
});
