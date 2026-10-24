import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWorkspaceLocation, droidChildEnv, inputPaths, makeGuard, patchPaths, TOOL_ALLOWLIST } from './guard.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ahead-guard-')));
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
fs.mkdirSync(path.join(ws, '.git'));
fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(ws, 'dangling'));
fs.symlinkSync('/etc', path.join(ws, 'etclink'));
fs.symlinkSync(path.join(ws, 'notes'), path.join(ws, 'notes-link'));
const guard = makeGuard(ws);

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('inside allows normal files and new subdirectories', () => {
  assert.equal(guard.inside('notes/spike.md'), true);
  assert.equal(guard.inside('notes/new/dir/x.md'), true);
  assert.equal(guard.inside(path.join(ws, 'notes', 'a.md')), true);
  assert.equal(guard.inside('notes-link/a.md'), true);
});

test('inside denies the root, .git, and escapes', () => {
  for (const p of ['.', '', '.git/hooks/post-commit', '.GIT/config', '../outside.txt', 'NOTES/../../x', '/etc/hosts']) {
    assert.equal(guard.inside(p), false, p);
  }
});

test('symlinks: dangling links deny, links out of the workspace deny', () => {
  assert.equal(guard.resolveStrict('dangling'), null);
  assert.equal(guard.inside('dangling'), false);
  assert.equal(guard.inside('dangling/x'), false);
  assert.equal(guard.inside('etclink/hosts'), false);
});

test('case variants of an outside path are still outside', () => {
  assert.equal(guard.inside(ws.toUpperCase() + '/../x'), false);
});

test('a root given through a symlinked spelling compares equal to its canonical form', () => {
  const alias = path.join(tmp, 'ws-alias');
  fs.symlinkSync(ws, alias);
  const g = makeGuard(alias);
  assert.equal(g.inside('notes/a.md'), true);
  assert.equal(g.inside(path.join(ws, 'notes', 'a.md')), true);
  assert.equal(g.inside('../x'), false);
});

test('patchPaths reads V4A and unified diff headers', () => {
  const body = '*** Begin Patch\n*** Update File: notes/a.md\n*** Move to: ../evil.md\n*** Add File: b.md\n--- a/c.md\n+++ b/c.md\n';
  assert.deepEqual(patchPaths(body), ['notes/a.md', '../evil.md', 'b.md', 'c.md', 'c.md']);
});

test('inputPaths covers glob prefixes, path arrays, and unknown path-like keys', () => {
  assert.deepEqual(inputPaths({ pattern: '../../**/.env*' }).paths, ['../../']);
  assert.deepEqual(inputPaths({ pattern: 'TODO', path: '../..' }).paths, ['../..']);
  assert.deepEqual(inputPaths({ paths: ['a', '/etc/x'], cmd: '../x' }).paths, ['a', '/etc/x', '../x']);
  assert.deepEqual(inputPaths({ other: 'notes/../../x' }).paths, ['notes/../../x']);
  assert.deepEqual(inputPaths({ content: 'a/b text', file_path: 'notes/x.md' }).paths, ['notes/x.md']);
});

test('droidChildEnv survives the SDK merge with only allowlisted keys', () => {
  const parent = { FACTORY_API_KEY: 'fk', PATH: '/bin', HOME: '/h', CARTESIA_API_KEY: 'c', MOSS_PROJECT_KEY: 'm', ANTHROPIC_API_KEY: 'a', LANG: undefined };
  const merged: Record<string, string | undefined> = { ...parent, ...droidChildEnv(parent) };
  const child = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  assert.deepEqual(child, { FACTORY_API_KEY: 'fk', PATH: '/bin', HOME: '/h' });
});

test('TOOL_ALLOWLIST is exactly the six allowed tools', () => {
  assert.deepEqual([...TOOL_ALLOWLIST].sort(), ['ApplyPatch', 'Create', 'Edit', 'Read', 'TodoWrite', 'ToolSearch']);
});

test('checkToolCall denies tools outside the allowlist', () => {
  assert.deepEqual(guard.checkToolCall('Execute', { command: 'ls' }), { reason: 'tool-not-allowed', path: null });
});

test('checkToolCall has no write exemption for outside paths', () => {
  assert.deepEqual(guard.checkToolCall('Create', { file_path: '../x' }), { reason: 'outside-workspace', path: '../x' });
  assert.deepEqual(guard.checkToolCall('Read', { file_path: '/etc/hosts' }), { reason: 'outside-workspace', path: '/etc/hosts' });
});

test('checkToolCall allows inside paths and content text', () => {
  assert.equal(guard.checkToolCall('Edit', { file_path: 'calendar.json' }), null);
  assert.equal(guard.checkToolCall('TodoWrite', { todos: [{ content: 'a/b' }] }), null);
});

test('assertWorkspaceLocation rejects nesting in either direction and accepts siblings', () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'ws'), { recursive: true });
  assert.throws(() => assertWorkspaceLocation(path.join(repo, 'ws'), repo), /workspace must be outside the repo/);
  assert.throws(() => assertWorkspaceLocation(repo, path.join(repo, 'ws')), /workspace must be outside the repo/);
  assert.throws(() => assertWorkspaceLocation(repo, repo), /workspace must be outside the repo/);
  assert.throws(() => assertWorkspaceLocation(path.join(repo, 'ws').toUpperCase(), repo), /workspace must be outside the repo/);
  assert.doesNotThrow(() => assertWorkspaceLocation(ws, repo));
  fs.mkdirSync(path.join(tmp, 'repo2'));
  assert.doesNotThrow(() => assertWorkspaceLocation(path.join(tmp, 'repo2'), repo));
});
