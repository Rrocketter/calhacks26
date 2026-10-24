import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceGit } from './git.js';

const seedCalendar = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../workspace-seed/calendar.json'),
  'utf8',
);
const dirs: string[] = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
};

// Same init/commit flags as scripts/reset-workspace.mjs. Only ever runs inside a fresh tmp dir.
function makeRepo(): { root: string; git: WorkspaceGit; raw: (...a: string[]) => string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ahead-git-')));
  dirs.push(root);
  const raw = (...args: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { env: cleanEnv() }).toString();
  raw('init', '-b', 'main');
  fs.writeFileSync(path.join(root, 'calendar.json'), seedCalendar);
  raw('add', '-A');
  raw('-c', 'user.name=ahead', '-c', 'user.email=ahead@localhost', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'seed');
  return { root, git: new WorkspaceGit(root), raw };
}

const editCalendar = (root: string) => {
  const f = path.join(root, 'calendar.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('2026-10-30T14:00:00-07:00', '2026-11-02T09:00:00-08:00'));
};

test('branchName sanitizes', () => {
  const { git } = makeRepo();
  assert.equal(git.branchName('a/b c'), 'spec/a-b-c');
  assert.equal(git.branchName('t1.x_y-z'), 'spec/t1.x_y-z');
});

test('prepare, edit, commitAll, diffFiles', async () => {
  const { root, git } = makeRepo();
  await git.prepare('t1');
  assert.equal(await git.currentBranch(), 'spec/t1');
  editCalendar(root);
  const sha = await git.commitAll('phase 2');
  assert.match(sha, /^[0-9a-f]{40}$/);
  const files = await git.diffFiles('t1');
  assert.equal(files.length, 1);
  assert.equal(files[0].file, 'calendar.json');
  assert.match(files[0].diff, /\+.*2026-11-02/);
});

test('commitAll allows an empty commit', async () => {
  const { git } = makeRepo();
  await git.prepare('t1');
  assert.match(await git.commitAll('empty'), /^[0-9a-f]{40}$/);
});

test('merge fast-forwards main and deletes the branch', async () => {
  const { root, git, raw } = makeRepo();
  await git.prepare('t1');
  editCalendar(root);
  await git.commitAll('x');
  await git.merge('t1');
  assert.equal(await git.currentBranch(), 'main');
  assert.match(fs.readFileSync(path.join(root, 'calendar.json'), 'utf8'), /2026-11-02/);
  assert.equal(raw('branch', '--list', 'spec/t1').trim(), '');
  assert.equal(await git.isClean(), true);
});

test('discard returns to unchanged main and tolerates a missing branch', async () => {
  const { root, git, raw } = makeRepo();
  await git.prepare('t1');
  editCalendar(root);
  await git.commitAll('x');
  await git.discard('t1');
  assert.equal(await git.currentBranch(), 'main');
  assert.equal(fs.readFileSync(path.join(root, 'calendar.json'), 'utf8'), seedCalendar);
  assert.equal(raw('branch', '--list', 'spec/t1').trim(), '');
  assert.equal(await git.isClean(), true);
  await git.discard('t1');
});

test('resetTo removes a later edit and an untracked file', async () => {
  const { root, git } = makeRepo();
  await git.prepare('t1');
  fs.writeFileSync(path.join(root, 'phase1.md'), 'p1');
  const sha = await git.commitAll('phase 1');
  editCalendar(root);
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  await git.resetTo(sha);
  assert.equal(fs.readFileSync(path.join(root, 'calendar.json'), 'utf8'), seedCalendar);
  assert.equal(fs.existsSync(path.join(root, 'stray.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'phase1.md')), true);
  assert.equal(await git.isClean(), true);
});

test('prepare cleans a dirty tree, untracked files and stale spec branches', async () => {
  const { root, git, raw } = makeRepo();
  raw('branch', 'spec/old');
  editCalendar(root);
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'x');
  assert.equal(await git.isClean(), false);
  await git.prepare('t2');
  assert.equal(await git.currentBranch(), 'spec/t2');
  assert.equal(await git.isClean(), true);
  assert.equal(raw('branch', '--list', 'spec/old').trim(), '');
  assert.equal(fs.existsSync(path.join(root, 'untracked.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'calendar.json'), 'utf8'), seedCalendar);
});

test('git failures reject with stderr', async () => {
  const { git } = makeRepo();
  await assert.rejects(git.resetTo('deadbeef'), /deadbeef|unknown revision|bad revision/i);
});
