import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DroidMessageType, ToolConfirmationOutcome, type DroidStreamEvent } from '@factory/droid-sdk/node';
import { parseServerEvent, type Belief, type ServerEvent } from '@ahead/contracts';
import { DroidExecutor } from './droid-executor.js';
import { WorkspaceGit } from './git.js';
import type { PermissionHandler } from './turn.js';
import { SpeculationFailed, type DroidLike } from './types.js';

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../workspace-seed');
const seedCalendar = fs.readFileSync(path.join(SEED, 'calendar.json'), 'utf8');
const dirs: string[] = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
test.beforeEach((t) => {
  t.mock.method(console, 'log', () => undefined);
});

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
};

// Seeded like scripts/reset-workspace.mjs, in a fresh tmp dir (never ~/.ahead).
function makeWorkspace(): { root: string; git: WorkspaceGit; raw: (...a: string[]) => string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ahead-exec-')));
  dirs.push(root);
  fs.cpSync(SEED, root, { recursive: true });
  const raw = (...args: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { env: cleanEnv() }).toString();
  raw('init', '-b', 'main');
  raw('add', '-A');
  raw('-c', 'user.name=ahead', '-c', 'user.email=ahead@localhost', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'seed');
  return { root, git: new WorkspaceGit(root), raw };
}

const ev = (e: Record<string, unknown>): DroidStreamEvent => e as unknown as DroidStreamEvent;
const call = (toolUseId: string, name: string, input: unknown) => ev({ type: DroidMessageType.ToolCall, toolUseId, name, input });
const result = (subtype: string) => ev({ type: DroidMessageType.Result, subtype, text: '' });
const text = (t: string) => ev({ type: DroidMessageType.AssistantTextDelta, text: t });

type Phase2Mode = 'edit' | 'block' | 'throw';
interface FakeSession extends DroidLike {
  prompts: string[];
  calls: string[];
}
interface Factory {
  open: (handler: PermissionHandler, signal: AbortSignal) => Promise<DroidLike>;
  sessions: FakeSession[];
  handlers: PermissionHandler[];
  signals: AbortSignal[];
  // Phase 2 behaviour per call, in order; 'edit' once exhausted.
  phase2: Phase2Mode[];
  // Phase 1 behaviour per call, in order; normal once exhausted.
  phase1: 'block'[];
  // When set, openSession waits on it before returning a session.
  openGate: Promise<void> | null;
  phase2Started: () => Promise<void>;
}

function moveEvent(root: string): void {
  const f = path.join(root, 'calendar.json');
  fs.writeFileSync(
    f,
    fs
      .readFileSync(f, 'utf8')
      .replace('2026-10-30T14:00:00-07:00', '2026-11-02T09:00:00-08:00')
      .replace('2026-10-30T15:00:00-07:00', '2026-11-02T10:00:00-08:00'),
  );
}

function factory(root: string, opts: { fail?: string } = {}): Factory {
  const f: Factory = {
    sessions: [],
    handlers: [],
    signals: [],
    phase2: [],
    phase1: [],
    openGate: null,
    open: async () => {
      throw new Error('unset');
    },
    phase2Started: () => Promise.resolve(),
  };
  let started: () => void = () => undefined;
  let startedP = new Promise<void>((r) => (started = r));
  f.phase2Started = () => startedP;
  f.open = async (handler, signal) => {
    f.handlers.push(handler);
    f.signals.push(signal);
    if (f.openGate) await f.openGate;
    if (opts.fail) throw new Error(opts.fail);
    const prompts: string[] = [];
    const calls: string[] = [];
    let active = false;
    let onInterrupt: () => void = () => undefined;
    const s: FakeSession = {
      prompts,
      calls,
      stream(prompt) {
        if (active) throw new Error('ConcurrentStreamError');
        active = true;
        prompts.push(prompt);
        const isPhase2 = prompt.includes('Today is');
        const mode: Phase2Mode = isPhase2 ? (f.phase2.shift() ?? 'edit') : (f.phase1.shift() ?? 'edit');
        return (async function* () {
          try {
            if (!isPhase2 && mode !== 'block') {
              yield call('1', 'Read', { file_path: 'calendar.json' });
              yield result('success');
              return;
            }
            if (mode === 'block') {
              const interrupted = new Promise<void>((r) => (onInterrupt = r));
              started();
              startedP = new Promise<void>((r) => (started = r));
              await interrupted;
              yield result('interrupted');
              return;
            }
            if (mode === 'throw') throw new Error('stream exploded');
            moveEvent(root);
            yield call('2', 'Edit', { file_path: 'calendar.json', old_str: 'a', new_str: 'b' });
            yield text('Moved the Priya review to Monday 9am.');
            yield result('success');
          } finally {
            active = false;
          }
        })();
      },
      async interrupt() {
        calls.push('interrupt');
        onInterrupt();
      },
      async close() {
        calls.push('close');
      },
    };
    f.sessions.push(s);
    return s;
  };
  return f;
}

const belief = (intent: Belief['intent'] = 'reschedule_event'): Belief => ({
  intent,
  entities: { person: 'Priya', date: 'Monday', time: '9:00 AM' },
  claims: [],
  confidence: 0.9,
  topHits: [],
  latencyMs: { moss: 1 },
});

function setup(opts: { fail?: string } = {}) {
  const ws = makeWorkspace();
  const f = factory(ws.root, opts);
  const events: ServerEvent[] = [];
  const exec = new DroidExecutor({
    workspace: ws.root,
    emit: (e) => events.push(e),
    openSession: f.open,
    graceMs: 50,
    now: () => new Date('2026-10-24T19:00:00Z'),
  });
  return { ...ws, f, events, exec };
}

type DroidEv = Extract<ServerEvent, { type: 'droid_event' }>;
const droid = (events: ServerEvent[], kind?: DroidEv['kind']): DroidEv[] =>
  events.filter((e): e is DroidEv => e.type === 'droid_event' && (kind === undefined || e.kind === kind));
const metrics = (events: ServerEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'metric' && e.source === 'droid' ? [e.label] : []));
function assertValid(events: ServerEvent[]): void {
  for (const e of events) assert.notEqual(parseServerEvent(JSON.stringify(e)), null, JSON.stringify(e));
}
const calendar = (root: string) => fs.readFileSync(path.join(root, 'calendar.json'), 'utf8');
const specBranches = (raw: (...a: string[]) => string) =>
  raw('for-each-ref', '--format=%(refname:short)', 'refs/heads/spec/').split('\n').filter(Boolean);

test('phase1 -> phase2 -> commit lands the change on main', async () => {
  const { root, git, raw, f, events, exec } = setup();
  await exec.warm();
  await exec.warm(); // no-op with a live session
  assert.equal(f.sessions.length, 1);

  await exec.phase1('t1', belief());
  assert.equal(await git.currentBranch(), 'spec/t1');
  assert.equal(calendar(root), seedCalendar);
  assert.deepEqual(await git.diffFiles('t1'), []);

  await exec.phase2('t1', belief());
  const diffs = droid(events, 'diff');
  assert.equal(diffs.length, 1);
  assert.equal((diffs[0]!.payload as { file: string }).file, 'calendar.json');
  assert.match((diffs[0]!.payload as { diff: string }).diff, /2026-11-02/);
  const results = droid(events, 'result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.payload, { ok: true, summary: 'Moved the Priya review to Monday 9am.' });
  assert.ok(events.indexOf(diffs[0]!) < events.indexOf(results[0]!));
  assert.ok(droid(events).every((e) => e.turnId === 't1'));

  await exec.commit('t1');
  assert.equal(await git.currentBranch(), 'main');
  assert.match(calendar(root), /2026-11-02T09:00:00-08:00/);
  assert.equal(await git.isClean(), true);
  assert.deepEqual(specBranches(raw), []);
  assert.deepEqual(f.sessions[0]!.calls, ['close']);
  assert.equal(f.sessions[0]!.prompts.length, 2);
  assert.deepEqual(metrics(events), ['createSession', 'phase1', 'phase2', 'diff', 'commit']);
  assertValid(events);
});

test('phase1 -> phase2 -> rollback leaves main unchanged', async () => {
  const { root, git, raw, f, events, exec } = setup();
  await exec.phase1('t1', belief());
  await exec.phase2('t1', belief());
  await exec.rollback('t1');
  assert.equal(await git.currentBranch(), 'main');
  assert.equal(calendar(root), seedCalendar);
  assert.equal(await git.isClean(), true);
  assert.deepEqual(specBranches(raw), []);
  assert.ok(f.sessions[0]!.calls.includes('close'));
  assert.ok(metrics(events).includes('rollback'));
  // Idempotent: unknown and finished turns still resolve.
  await exec.rollback('t1');
  await exec.rollback('nope');
  assertValid(events);
});

test('phase1 passes the files/ listing to the prompt', async () => {
  const { f, exec } = setup();
  await exec.phase1('t1', belief('find_file'));
  const p = f.sessions[0]!.prompts[0]!;
  assert.match(p, /files\/budget-2026\.xlsx\.txt\nfiles\/q3-deck\.pdf/);
});

test('resetToPhase1 after phase2 restores post-phase1 content; a second phase2 works', async () => {
  const { root, git, events, exec } = setup();
  await exec.phase1('t1', belief());
  await exec.phase2('t1', belief());
  assert.match(calendar(root), /2026-11-02/);
  await exec.resetToPhase1('t1');
  assert.equal(calendar(root), seedCalendar);
  assert.equal(await git.currentBranch(), 'spec/t1');
  assert.equal(await git.isClean(), true);
  await exec.phase2('t1', belief());
  assert.equal(droid(events, 'diff').length, 2);
  assert.equal(droid(events, 'result').length, 2);
  assert.match(calendar(root), /2026-11-02/);
  assertValid(events);
});

test('phase1 for t2 while t1 is live rolls t1 back first', async () => {
  const { git, raw, f, events, exec } = setup();
  await exec.phase1('t1', belief());
  await exec.phase2('t1', belief());
  await exec.phase1('t2', belief());
  assert.deepEqual(specBranches(raw), ['spec/t2']);
  assert.equal(await git.currentBranch(), 'spec/t2');
  assert.ok(f.sessions[0]!.calls.includes('close'));
  assert.equal(f.sessions.length, 2);
  assert.deepEqual(await git.diffFiles('t2'), []);
  assertValid(events);
});

test('phase1 for the same turnId while live starts fresh', async () => {
  const { raw, f, exec } = setup();
  await exec.phase1('t1', belief());
  await exec.phase1('t1', belief());
  assert.deepEqual(specBranches(raw), ['spec/t1']);
  assert.equal(f.sessions.length, 2);
});

test('a stream that throws in phase2 -> SpeculationFailed; rollback cleans; warm reopens', async () => {
  const { root, git, raw, f, events, exec } = setup();
  f.phase2.push('throw');
  await exec.phase1('t1', belief());
  await assert.rejects(exec.phase2('t1', belief()), SpeculationFailed);
  assert.ok(f.sessions[0]!.calls.includes('close'));
  assert.equal(droid(events, 'result').length, 0);
  await exec.rollback('t1');
  assert.equal(await git.currentBranch(), 'main');
  assert.equal(await git.isClean(), true);
  assert.equal(calendar(root), seedCalendar);
  assert.deepEqual(specBranches(raw), []);
  await exec.warm();
  assert.equal(f.sessions.length, 2);
  assertValid(events);
});

test('openSession rejecting: warm emits an error, phase1 throws SpeculationFailed', async () => {
  const { events, exec } = setup({ fail: 'droid sandbox disabled' });
  await exec.warm();
  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.deepEqual(errs[0], { type: 'error', source: 'droid', message: 'droid sandbox disabled' });
  await assert.rejects(exec.phase1('t1', belief()), SpeculationFailed);
  assertValid(events);
});

test('warm error messages never carry env values', async () => {
  const secret = 'sk-test-' + 'x'.repeat(24);
  process.env.AHEAD_TEST_SECRET = secret;
  try {
    const { events, exec } = setup({ fail: `bad key ${secret}` });
    await exec.warm();
    const err = events.find((e) => e.type === 'error') as { message: string };
    assert.ok(!err.message.includes(secret));
  } finally {
    delete process.env.AHEAD_TEST_SECRET;
  }
});

test('back-to-back un-awaited phase1, phase2, commit run in order', async () => {
  const { root, git, raw, events, exec } = setup();
  const done: string[] = [];
  const p1 = exec.phase1('t1', belief()).then(() => done.push('phase1'));
  const p2 = exec.phase2('t1', belief()).then(() => done.push('phase2'));
  const pc = exec.commit('t1').then(() => done.push('commit'));
  await Promise.all([p1, p2, pc]);
  assert.deepEqual(done, ['phase1', 'phase2', 'commit']);
  assert.deepEqual(metrics(events), ['createSession', 'phase1', 'phase2', 'diff', 'commit']);
  assert.match(calendar(root), /2026-11-02/);
  assert.equal(await git.currentBranch(), 'main');
  assert.deepEqual(specBranches(raw), []);
  assertValid(events);
});

test('resume during a blocked phase2 resolves it quietly; a fresh phase2 then succeeds', { timeout: 5000 }, async () => {
  const { root, git, f, events, exec } = setup();
  f.phase2.push('block');
  await exec.phase1('t1', belief());
  const started = f.phase2Started();
  const blocked = exec.phase2('t1', belief());
  await started;
  await exec.resetToPhase1('t1');
  await blocked; // resolves, no throw
  assert.ok(f.sessions[0]!.calls.includes('interrupt'));
  assert.ok(!f.sessions[0]!.calls.includes('close'));
  assert.equal(droid(events, 'diff').length, 0);
  assert.equal(droid(events, 'result').length, 0);
  assert.equal(calendar(root), seedCalendar);
  assert.equal(await git.currentBranch(), 'spec/t1');
  await exec.phase2('t1', belief());
  assert.equal(droid(events, 'result').length, 1);
  assert.equal(f.sessions.length, 1);
  assertValid(events);
});

test('rollback during a blocked phase2 resolves it quietly', { timeout: 5000 }, async () => {
  const { root, git, f, events, exec } = setup();
  f.phase2.push('block');
  await exec.phase1('t1', belief());
  const started = f.phase2Started();
  const blocked = exec.phase2('t1', belief());
  await started;
  await exec.rollback('t1');
  await blocked;
  assert.equal(droid(events, 'result').length, 0);
  assert.equal(calendar(root), seedCalendar);
  assert.equal(await git.currentBranch(), 'main');
});

test('permission handler is bound to the live turnId', async () => {
  const { f, events, exec } = setup();
  await exec.warm();
  const params = {
    toolUses: [{ toolUse: { name: 'Execute', input: {} }, confirmationType: 'exec', details: { type: 'exec' } }],
    options: [{ value: ToolConfirmationOutcome.ProceedOnce }],
  } as unknown as Parameters<PermissionHandler>[0];
  assert.equal(f.handlers[0]!(params), ToolConfirmationOutcome.Cancel);
  await exec.phase1('t1', belief());
  f.handlers[0]!(params);
  const denied = droid(events, 'tool').filter((e) => e.denied);
  assert.deepEqual(denied.map((e) => e.turnId), ['none', 't1']);
  assert.equal(f.signals[0]!.aborted, false);
  assertValid(events);
});

test('rollback during a blocked phase1 resolves it quietly and removes the branch', { timeout: 5000 }, async () => {
  const { root, git, raw, f, events, exec } = setup();
  f.phase1.push('block');
  const started = f.phase2Started();
  const blocked = exec.phase1('t1', belief());
  await started;
  await exec.rollback('t1');
  await blocked;
  assert.ok(f.sessions[0]!.calls.includes('interrupt'));
  assert.equal(await git.currentBranch(), 'main');
  assert.deepEqual(specBranches(raw), []);
  assert.equal(calendar(root), seedCalendar);
  assertValid(events);
});

test('same tick: rollback(t1) then phase1(t2) leaves spec/t2 live with a session', { timeout: 5000 }, async () => {
  const { git, raw, f, events, exec } = setup();
  await exec.phase1('t1', belief());
  const r = exec.rollback('t1');
  const p = exec.phase1('t2', belief());
  await Promise.all([r, p]);
  assert.deepEqual(specBranches(raw), ['spec/t2']);
  assert.equal(await git.currentBranch(), 'spec/t2');
  assert.equal(f.sessions.length, 2);
  assert.ok(!f.sessions[1]!.calls.includes('close'));
  await exec.phase2('t2', belief());
  assert.equal(droid(events, 'result').length, 1);
});

test('same tick: resetToPhase1(t1) then phase2(t1) keeps the new diff on the branch', { timeout: 5000 }, async () => {
  const { root, git, events, exec } = setup();
  await exec.phase1('t1', belief());
  await exec.phase2('t1', belief());
  const r = exec.resetToPhase1('t1');
  const p = exec.phase2('t1', belief());
  await Promise.all([r, p]);
  assert.equal(droid(events, 'result').length, 2);
  assert.match(calendar(root), /2026-11-02/);
  assert.equal((await git.diffFiles('t1')).length, 1);
  assert.equal(await git.isClean(), true);
});

for (const op of ['commit', 'rollback'] as const) {
  test(`same tick: ${op}(t1) then warm() leaves a fresh session`, { timeout: 5000 }, async () => {
    const { f, exec } = setup();
    await exec.phase1('t1', belief());
    await exec.phase2('t1', belief());
    const a = exec[op]('t1');
    const w = exec.warm();
    await Promise.all([a, w]);
    assert.equal(f.sessions.length, 2);
    assert.ok(f.sessions[0]!.calls.includes('close'));
    assert.ok(!f.sessions[1]!.calls.includes('close'));
    await exec.warm();
    assert.equal(f.sessions.length, 2);
  });
}

test('resetToPhase1 for a turn that is not live does not interrupt the running phase', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup();
  await exec.phase1('t1', belief());
  f.phase2.push('block');
  const started = f.phase2Started();
  const blocked = exec.phase2('t1', belief());
  await started;
  const r = exec.resetToPhase1('other');
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(!f.sessions[0]!.calls.includes('interrupt'));
  await exec.rollback('t1');
  await Promise.all([blocked, r]);
  assertValid(events);
});

test('un-awaited phase1, phase2, resetToPhase1, phase2 runs only the fresh phase2', { timeout: 5000 }, async () => {
  const { root, git, events, exec } = setup();
  await Promise.all([
    exec.phase1('t1', belief()),
    exec.phase2('t1', belief()),
    exec.resetToPhase1('t1'),
    exec.phase2('t1', belief()),
  ]);
  assert.equal(droid(events, 'result').length, 1);
  assert.equal(droid(events, 'diff').length, 1);
  assert.match(calendar(root), /2026-11-02/);
  assert.equal(await git.currentBranch(), 'spec/t1');
  assertValid(events);
});

test('rollback while phase1 waits for the session open: the phase1 prompt is never streamed', { timeout: 5000 }, async () => {
  const { git, raw, f, exec } = setup();
  let release: () => void = () => undefined;
  f.openGate = new Promise<void>((r) => (release = r));
  const p1 = exec.phase1('t1', belief());
  await new Promise((r) => setTimeout(r, 10)); // phase1 is now parked in openSession
  assert.equal(f.handlers.length, 1);
  const rb = exec.rollback('t1');
  release();
  await Promise.all([p1, rb]);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.sessions[0]!.prompts.length, 0);
  assert.equal(await git.currentBranch(), 'main');
  assert.deepEqual(specBranches(raw), []);
});
