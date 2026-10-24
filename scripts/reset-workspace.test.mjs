import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonical, checkTarget, readEnvValue, resolveWorkspace } from './reset-workspace.mjs';

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
  assert.equal(resolveWorkspace('', home, repoRoot), dflt);
  assert.equal(resolveWorkspace(undefined, home, repoRoot), dflt);
});

test('expands leading ~', () => {
  assert.equal(resolveWorkspace('~/x', home, repoRoot), path.join(home, 'x'));
  assert.equal(resolveWorkspace('~', home, repoRoot), home);
});

test('relative values resolve against the repo root, so the guard refuses them', () => {
  assert.equal(resolveWorkspace('var/ws', home, repoRoot), path.join(repoRoot, 'var', 'ws'));
  assert.match(check(resolveWorkspace('var/ws', home, repoRoot)), /inside the repo/);
  assert.equal(resolveWorkspace('../ws', home, repoRoot), path.join(path.dirname(repoRoot), 'ws'));
});

test('readEnvValue reads only the named key from a .env file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ahead-env-'));
  const file = path.join(dir, '.env');
  writeFileSync(
    file,
    [
      '# comment',
      'OTHER_KEY=sk_should_not_matter',
      'AHEAD_WORKSPACE=/tmp/first',
      '  AHEAD_WORKSPACE = "/tmp/quoted ws"  ',
      'AHEAD_WORKSPACE_X=/tmp/nope',
      '',
    ].join('\n'),
  );
  assert.equal(readEnvValue(file, 'AHEAD_WORKSPACE'), '/tmp/quoted ws');
  writeFileSync(file, "AHEAD_WORKSPACE='~/single' # trailing\n");
  assert.equal(readEnvValue(file, 'AHEAD_WORKSPACE'), '~/single');
  writeFileSync(file, 'AHEAD_WORKSPACE=/tmp/bare # comment\n');
  assert.equal(readEnvValue(file, 'AHEAD_WORKSPACE'), '/tmp/bare');
  writeFileSync(file, 'AHEAD_WORKSPACE=\n');
  assert.equal(readEnvValue(file, 'AHEAD_WORKSPACE'), '');
  writeFileSync(file, 'OTHER=1\n');
  assert.equal(readEnvValue(file, 'AHEAD_WORKSPACE'), undefined);
  assert.equal(readEnvValue(path.join(dir, 'missing.env'), 'AHEAD_WORKSPACE'), undefined);
});

test('accepts default and scratch paths', () => {
  assert.equal(check(path.join(home, '.ahead', 'workspace')), null);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ahead-test-'));
  assert.equal(check(path.join(scratch, 'ws')), null);
});
