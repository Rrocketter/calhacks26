import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sandboxSettings, verifyAllowedTools, verifySandbox, writeSandboxSettings } from './sandbox.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-')));
const home = path.join(tmp, 'home');
const repoRoot = path.join(tmp, 'repo');
const workspace = path.join(home, '.ahead', 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });
const opts = { home, repoRoot, workspace };

type Fs = { denyRead: string[]; allowRead: string[]; denyWrite: string[] };
const fsOf = (s: object): Fs => (s as { sandbox: { filesystem: Fs } }).sandbox.filesystem;

test('sandboxSettings enables per-command sandbox', () => {
  const s = sandboxSettings(opts) as { sandbox: { enabled: boolean; mode: string } };
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.mode, 'per-command');
});

test('sandboxSettings denyRead covers home, repo and ~/.factory; allowRead is the workspace', () => {
  const f = fsOf(sandboxSettings(opts));
  assert.ok(f.denyRead.includes(home));
  assert.ok(f.denyRead.includes(repoRoot));
  assert.ok(f.denyRead.includes(path.join(home, '.factory')));
  assert.deepEqual(f.allowRead, [workspace]);
});

test('sandboxSettings denyWrite starts with workspace .git and includes the repo', () => {
  const f = fsOf(sandboxSettings(opts));
  assert.equal(f.denyWrite[0], path.join(workspace, '.git'));
  assert.ok(f.denyWrite.includes(repoRoot));
});

test('writeSandboxSettings writes the JSON file', () => {
  const file = writeSandboxSettings(tmp, opts);
  assert.equal(path.basename(file), 'droid-settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), sandboxSettings(opts));
});

test('verifySandbox rejects disabled or missing sandbox', () => {
  assert.throws(() => verifySandbox({ sandbox: { enabled: false } }), /sandbox disabled/);
  assert.throws(() => verifySandbox({}), /sandbox disabled/);
  assert.throws(() => verifySandbox(undefined), /sandbox disabled/);
  verifySandbox({ sandbox: { enabled: true } });
});

const base = ['Create', 'Edit', 'Read', 'TodoWrite', 'ToolSearch'];
const tools = (allowed: string[], extra: string[] = []) =>
  [...new Set([...allowed, ...extra])].map((id) => ({ id, allowed: allowed.includes(id) }));

test('verifyAllowedTools accepts the exact base set and optional ApplyPatch', () => {
  assert.deepEqual(verifyAllowedTools(tools(base, ['LS'])), base);
  assert.deepEqual(verifyAllowedTools(tools([...base, 'ApplyPatch'])), [...base, 'ApplyPatch'].sort());
});

test('verifyAllowedTools rejects extra or missing tools', () => {
  assert.throws(() => verifyAllowedTools(tools([...base, 'LS'])), /allowed tool set mismatch/);
  assert.throws(() => verifyAllowedTools(tools(base.filter((t) => t !== 'Create'))), /allowed tool set mismatch/);
});
