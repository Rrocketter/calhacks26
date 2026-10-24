// Path-guard checks for spike-droid.ts (seed for the Lane C executor's TDD suite).
// Runs against a throwaway workspace: AHEAD_WORKSPACE is set before the module is imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ahead-guard-')));
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
fs.mkdirSync(path.join(ws, '.git'));
fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(ws, 'dangling'));
fs.symlinkSync('/etc', path.join(ws, 'etclink'));
fs.symlinkSync(path.join(ws, 'notes'), path.join(ws, 'notes-link'));
process.env.AHEAD_WORKSPACE = ws;

const { droidChildEnv, insideWorkspace, inputPaths, patchPaths, resolveStrict } = await import('./spike-droid.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('insideWorkspace allows normal files and new subdirectories', () => {
  assert.equal(insideWorkspace('notes/spike.md'), true);
  assert.equal(insideWorkspace('notes/new/dir/x.md'), true);
  assert.equal(insideWorkspace(path.join(ws, 'notes', 'a.md')), true);
  assert.equal(insideWorkspace('notes-link/a.md'), true);
});

test('insideWorkspace denies the root, .git, and escapes', () => {
  for (const p of ['.', '', '.git/hooks/post-commit', '.GIT/config', '../outside.txt', 'NOTES/../../x', '/etc/hosts']) {
    assert.equal(insideWorkspace(p), false, p);
  }
});

test('symlinks: dangling links deny, links out of the workspace deny', () => {
  assert.equal(resolveStrict('dangling'), null);
  assert.equal(insideWorkspace('dangling'), false);
  assert.equal(insideWorkspace('dangling/x'), false);
  assert.equal(insideWorkspace('etclink/hosts'), false);
});

test('case variants of an outside path are still outside', () => {
  assert.equal(insideWorkspace(ws.toUpperCase() + '/../x'), false);
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
  // Same merge as @factory/droid-sdk@0.10.0 ProcessManager: {...process.env, ...config.env}.
  const merged: Record<string, string | undefined> = { ...parent, ...droidChildEnv(parent) };
  // child_process.spawn drops undefined values.
  const child = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  assert.deepEqual(child, { FACTORY_API_KEY: 'fk', PATH: '/bin', HOME: '/h' });
});
