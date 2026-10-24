import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeCalendarDir } from './calendar-layout.mjs';
import { canonical, checkTarget, copySeed, missingGoogle, overlayGoogle, readEnvValue, resolveWorkspace } from './reset-workspace.mjs';

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

test('google overlay: reports missing files, then writes calendar/ and contacts over the seed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ahead-repo-'));
  const ws = mkdtempSync(path.join(os.tmpdir(), 'ahead-ws-'));
  mkdirSync(path.join(root, 'data', 'google'), { recursive: true });
  assert.match(missingGoogle(root), /contacts\.json is missing/);
  writeFileSync(path.join(root, 'data', 'google', 'contacts.json'), '{"contacts":[]}\n');
  assert.match(missingGoogle(root), /data\/google\/calendar\/ is missing/);
  const ev = { id: 'g-evt-a_1', title: 'SETI Research Meeting', start: '2026-10-27T13:00:00-07:00', end: '2026-10-27T14:00:00-07:00' };
  writeCalendarDir([ev], path.join(root, 'data', 'google', 'calendar'));
  assert.equal(missingGoogle(root), null);
  writeCalendarDir([{ id: 'seed-1', title: 'seed', start: '2026-10-30T14:00:00-07:00' }], path.join(ws, 'calendar'));
  assert.deepEqual(overlayGoogle(root, ws), ['calendar/', 'contacts.json']);
  assert.deepEqual(readdirSync(path.join(ws, 'calendar')).sort(), ['g-evt-a_1.json', 'index.json']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(ws, 'calendar', 'g-evt-a_1.json'), 'utf8')), ev);
  assert.equal(readFileSync(path.join(ws, 'contacts.json'), 'utf8'), '{"contacts":[]}\n');
});

test('google overlay: a single calendar.json from an older import is split into calendar/', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ahead-repo-'));
  const ws = mkdtempSync(path.join(os.tmpdir(), 'ahead-ws-'));
  mkdirSync(path.join(root, 'data', 'google'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'google', 'contacts.json'), '{"contacts":[]}\n');
  const events = [
    { id: 'b', title: 'Later', start: '2026-10-28T09:00:00-07:00' },
    { id: 'a/x', title: 'Earlier', start: '2026-10-26T09:00:00-07:00' },
  ];
  writeFileSync(path.join(root, 'data', 'google', 'calendar.json'), JSON.stringify({ events }));
  assert.equal(missingGoogle(root), null);
  overlayGoogle(root, ws);
  const index = JSON.parse(readFileSync(path.join(ws, 'calendar', 'index.json'), 'utf8'));
  assert.deepEqual(index, [
    { id: 'a/x', title: 'Earlier', start: '2026-10-26T09:00:00-07:00', file: 'calendar/a_x.json' },
    { id: 'b', title: 'Later', start: '2026-10-28T09:00:00-07:00', file: 'calendar/b.json' },
  ]);
  assert.equal(existsSync(path.join(ws, 'calendar.json')), false);
});

test('copySeed writes the seed calendar as one file per event and no calendar.json', () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'ahead-ws-'));
  const n = copySeed(path.join(repoRoot, 'workspace-seed'), ws);
  assert.equal(existsSync(path.join(ws, 'calendar.json')), false);
  assert.ok(existsSync(path.join(ws, 'calendar', 'evt-priya-q3.json')));
  assert.equal(readdirSync(path.join(ws, 'calendar')).length, n + 1);
  assert.ok(existsSync(path.join(ws, 'files', 'seti-slides.pdf')));
});
