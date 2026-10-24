import { test , type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DroidMessageType, ToolConfirmationOutcome, type DroidStreamEvent } from '@factory/droid-sdk/node';
import { parseServerEvent, type Belief, type ServerEvent } from '@ahead/contracts';
import { readCalendar, writeCalendarDir } from '../../../../scripts/calendar-layout.mjs';
import { DroidExecutor } from './droid-executor.js';
import { WorkspaceGit } from './git.js';
import type { PermissionHandler } from './turn.js';
import { SpeculationFailed, type DroidLike } from './types.js';

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../workspace-seed');
// The workspace calendar is one file per event (scripts/calendar-layout.mjs); tests move this one.
const EVT = 'calendar/evt-priya-q3.json';
const seedCalendar = JSON.stringify(readCalendar(SEED)!.find((e) => e.id === 'evt-priya-q3'), null, 2) + '\n';
const dirs: string[] = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
test.beforeEach((t) => {
  const tc = t as TestContext;
  tc.mock.method(console, 'log', () => undefined);
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
  fs.cpSync(SEED, root, { recursive: true, filter: (src) => src !== path.join(SEED, 'calendar.json') });
  writeCalendarDir(readCalendar(SEED)!, path.join(root, 'calendar'));
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
const toolResult = (toolUseId: string, toolName: string) =>
  ev({ type: DroidMessageType.ToolResult, toolUseId, toolName, isError: false, content: 'body' });

// edit: Edit call, no ToolResult (diff only at turn end). early: Edit + ToolResult, then afterWrite.
// early-changed: like early, then a second change before the Result. create: Create of notes/new.md.
// early-block: like early, then blocks until interrupted. early-fail: like early, then an error Result.
// draft-thursday / draft-friday: Create of messages/outbox/priya.md naming that day, with a ToolResult.
type Phase2Mode = 'edit' | 'block' | 'throw' | 'early' | 'early-changed' | 'create' | 'early-block' | 'early-fail' | 'draft-thursday' | 'draft-friday';
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
  // Phase 1 behaviour per call, in order; normal once exhausted. deaf ignores interrupt, ends only on close.
  phase1: ('block' | 'deaf')[];
  // Awaited by the early modes after the write's ToolResult, before the Result.
  afterWrite: () => Promise<void>;
  // Called by the early modes just before the write's ToolResult is yielded.
  beforeWriteResult: () => void;
  // When set, openSession waits on it before returning a session.
  openGate: Promise<void> | null;
  phase2Started: () => Promise<void>;
}

function moveEvent(root: string): void {
  const f = path.join(root, EVT);
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
    afterWrite: () => Promise.resolve(),
    beforeWriteResult: () => undefined,
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
    let onClose: () => void = () => undefined;
    const closed = new Promise<void>((r) => (onClose = r));
    const s: FakeSession = {
      prompts,
      calls,
      stream(prompt) {
        if (active) throw new Error('ConcurrentStreamError');
        active = true;
        prompts.push(prompt);
        const isPhase2 = prompt.includes('Today is');
        const mode: Phase2Mode | 'deaf' = isPhase2 ? (f.phase2.shift() ?? 'edit') : (f.phase1.shift() ?? 'edit');
        return (async function* () {
          try {
            if (mode === 'deaf') {
              started();
              await closed;
              return;
            }
            if (!isPhase2 && mode !== 'block') {
              yield call('1', 'Read', { file_path: EVT });
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
            if (mode === 'draft-thursday' || mode === 'draft-friday') {
              const day = mode === 'draft-thursday' ? 'Thursday' : 'Friday';
              fs.writeFileSync(path.join(root, 'messages', 'outbox', 'priya.md'), `To: Priya Shah\n\nHi Priya, see you ${day} at 2.\n`);
              yield call('3', 'Create', { file_path: 'messages/outbox/priya.md', content: day });
              yield toolResult('3', 'Create');
              yield result('success');
              return;
            }
            if (mode === 'create') {
              fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
              fs.writeFileSync(path.join(root, 'notes', 'new.md'), '# new\n');
              yield call('2', 'Create', { file_path: 'notes/new.md', content: '# new' });
              yield toolResult('2', 'Create');
              await f.afterWrite();
              yield result('success');
              return;
            }
            if (mode === 'early' || mode === 'early-changed' || mode === 'early-block' || mode === 'early-fail') {
              moveEvent(root);
              yield call('2', 'Edit', { file_path: EVT, old_str: 'a', new_str: 'b' });
              f.beforeWriteResult();
              yield toolResult('2', 'Edit');
              await f.afterWrite();
              if (mode === 'early-fail') {
                yield result('error');
                return;
              }
              if (mode === 'early-block') {
                const interrupted = new Promise<void>((r) => (onInterrupt = r));
                started();
                startedP = new Promise<void>((r) => (started = r));
                await interrupted;
                yield result('interrupted');
                return;
              }
              if (mode === 'early-changed') {
                const cal = path.join(root, EVT);
                fs.writeFileSync(cal, fs.readFileSync(cal, 'utf8').replace('2026-11-02T09:00:00-08:00', '2026-11-02T08:30:00-08:00'));
              }
              yield text('Moved it.');
              yield result('success');
              return;
            }
            moveEvent(root);
            yield call('2', 'Edit', { file_path: EVT, old_str: 'a', new_str: 'b' });
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
        onClose();
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

function setup(opts: { fail?: string; phaseTimeoutMs?: number; interruptGraceMs?: number; openTimeoutMs?: number } = {}) {
  const ws = makeWorkspace();
  const f = factory(ws.root, opts);
  const events: ServerEvent[] = [];
  const exec = new DroidExecutor({
    workspace: ws.root,
    emit: (e) => events.push(e),
    openSession: f.open,
    graceMs: 50,
    now: () => new Date('2026-10-24T19:00:00Z'),
    ...(opts.phaseTimeoutMs === undefined ? {} : { phaseTimeoutMs: opts.phaseTimeoutMs }),
    ...(opts.interruptGraceMs === undefined ? {} : { interruptGraceMs: opts.interruptGraceMs }),
    ...(opts.openTimeoutMs === undefined ? {} : { openTimeoutMs: opts.openTimeoutMs }),
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
const calendar = (root: string) => fs.readFileSync(path.join(root, EVT), 'utf8');
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
  assert.equal((diffs[0]!.payload as { file: string }).file, EVT);
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

test('close() after commit: the queued warm opens nothing, the session is closed', { timeout: 5000 }, async () => {
  const { f, exec } = setup();
  await exec.phase1('t1', belief());
  await exec.phase2('t1', belief());
  const a = exec.commit('t1');
  const w = exec.warm();
  const c = exec.close();
  await Promise.all([a, w, c]);
  assert.equal(f.sessions.length, 1);
  assert.deepEqual(f.sessions[0]!.calls, ['close']);
  await exec.warm();
  assert.equal(f.sessions.length, 1);
  await exec.close(); // idempotent
  assert.deepEqual(f.sessions[0]!.calls, ['close']);
});

test('close() is terminal: a later warm() opens nothing', { timeout: 5000 }, async () => {
  const { f, exec } = setup();
  await exec.warm();
  await exec.close();
  const before = f.sessions.length;
  await exec.warm();
  assert.equal(f.sessions.length, before);
  assert.deepEqual(f.sessions[0]!.calls, ['close']);
});

test('close() is terminal: phase1 and phase2 reject with SpeculationFailed', { timeout: 5000 }, async () => {
  const { f, exec } = setup();
  await exec.close();
  await assert.rejects(exec.phase1('t1', belief()), (e: unknown) => e instanceof SpeculationFailed && e.message === 'executor closed');
  await assert.rejects(exec.phase2('t1', belief()), (e: unknown) => e instanceof SpeculationFailed && e.message === 'executor closed');
  assert.equal(f.sessions.length, 0);
});

test('a warm session idle longer than phaseTimeoutMs still runs phase1', { timeout: 5000 }, async () => {
  const { git, f, events, exec } = setup({ phaseTimeoutMs: 50 });
  await exec.warm();
  await new Promise((r) => setTimeout(r, 100));
  await exec.phase1('t1', belief());
  assert.equal(f.sessions.length, 1);
  assert.deepEqual(f.sessions[0]!.calls, []);
  assert.equal(f.signals[0]!.aborted, false);
  assert.equal(await git.currentBranch(), 'spec/t1');
  assert.ok(metrics(events).includes('phase1'));
  assertValid(events);
});

// The phase timer is unref'd; hold the event loop open the way the running server would.
function keepAlive<T>(p: Promise<T>): Promise<T> {
  const keep = setInterval(() => undefined, 1000);
  return p.finally(() => clearInterval(keep));
}

test('a phase1 stream blocked past phaseTimeoutMs is interrupted, rejects, and closes the session', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup({ phaseTimeoutMs: 50 });
  f.phase1.push('block');
  await assert.rejects(keepAlive(exec.phase1('t1', belief())), SpeculationFailed);
  assert.deepEqual(f.sessions[0]!.calls, ['interrupt', 'close']);
  assert.equal(f.signals[0]!.aborted, true);
  assertValid(events);
});

test('a phase2 stream blocked past phaseTimeoutMs is interrupted, rejects, and closes the session', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup({ phaseTimeoutMs: 50 });
  await exec.phase1('t1', belief());
  f.phase2.push('block');
  await assert.rejects(keepAlive(exec.phase2('t1', belief())), SpeculationFailed);
  assert.deepEqual(f.sessions[0]!.calls, ['interrupt', 'close']);
  assertValid(events);
});

// The fake waits (up to 2 s) for a diff event after the write's ToolResult, then records a marker
// metric, then yields the Result. An early diff therefore sits before the marker; a turn-end diff after it.
const MARKER = 'MARKER';
function withMarker(f: Factory, events: ServerEvent[]): void {
  f.afterWrite = async () => {
    const until = Date.now() + 2000;
    while (Date.now() < until && droid(events, 'diff').length === 0) await new Promise((r) => setTimeout(r, 5));
    events.push({ type: 'metric', source: 'droid', label: MARKER, ms: 0 });
  };
}
const markerAt = (events: ServerEvent[]): number => events.findIndex((e) => e.type === 'metric' && e.label === MARKER);

test('early diff: emitted when the Edit result returns, before the Result; no duplicate at turn end', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup();
  withMarker(f, events);
  await exec.phase1('t1', belief());
  f.phase2.push('early');
  await exec.phase2('t1', belief());
  const diffs = droid(events, 'diff');
  assert.equal(diffs.length, 1);
  assert.equal((diffs[0]!.payload as { file: string }).file, EVT);
  assert.match((diffs[0]!.payload as { diff: string }).diff, /2026-11-02T09:00:00-08:00/);
  assert.ok(events.indexOf(diffs[0]!) < markerAt(events), 'diff before marker');
  const result = droid(events, 'result')[0]!;
  assert.ok(markerAt(events) < events.indexOf(result));
  assert.deepEqual(metrics(events), ['createSession', 'phase1', 'first-diff', MARKER, 'phase2', 'diff']);
  assertValid(events);
});

test('early diff: a final diff that differs is re-emitted exactly once', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup();
  withMarker(f, events);
  await exec.phase1('t1', belief());
  f.phase2.push('early-changed');
  await exec.phase2('t1', belief());
  const diffs = droid(events, 'diff');
  assert.equal(diffs.length, 2);
  assert.ok(events.indexOf(diffs[0]!) < markerAt(events));
  assert.ok(markerAt(events) < events.indexOf(diffs[1]!));
  assert.match((diffs[0]!.payload as { diff: string }).diff, /\+.*2026-11-02T09:00:00-08:00/);
  assert.match((diffs[1]!.payload as { diff: string }).diff, /\+.*2026-11-02T08:30:00-08:00/);
  assert.ok(events.indexOf(diffs[1]!) < events.indexOf(droid(events, 'result')[0]!));
  assertValid(events);
});

test('early diff: a Create of a new file shows up before the Result', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup();
  withMarker(f, events);
  await exec.phase1('t1', belief('add_note'));
  f.phase2.push('create');
  await exec.phase2('t1', belief('add_note'));
  const diffs = droid(events, 'diff');
  assert.equal(diffs.length, 1);
  assert.equal((diffs[0]!.payload as { file: string }).file, 'notes/new.md');
  assert.match((diffs[0]!.payload as { diff: string }).diff, /new file mode[\s\S]*\+# new/);
  assert.ok(events.indexOf(diffs[0]!) < markerAt(events));
  assertValid(events);
});

test('early diff: a write result that arrives after rollback emits nothing', { timeout: 5000 }, async () => {
  const { root, git, f, events, exec } = setup();
  await exec.phase1('t1', belief());
  let rolled: Promise<void> = Promise.resolve();
  // The rollback bumps the generation synchronously; its git work waits for phase2 on the chain.
  f.beforeWriteResult = () => {
    rolled = exec.rollback('t1');
  };
  f.phase2.push('early');
  await exec.phase2('t1', belief());
  await rolled;
  assert.equal(droid(events, 'diff').length, 0);
  assert.equal(droid(events, 'result').length, 0);
  assert.ok(!metrics(events).includes('first-diff'));
  assert.equal(calendar(root), seedCalendar);
  assert.equal(await git.currentBranch(), 'main');
  assertValid(events);
});

test('phase1 that ignores interrupt is closed after the grace period; the chain is not wedged', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup({ phaseTimeoutMs: 50, interruptGraceMs: 50 });
  f.phase1.push('deaf');
  const t0 = performance.now();
  await assert.rejects(keepAlive(exec.phase1('t1', belief())), SpeculationFailed);
  const took = performance.now() - t0;
  assert.ok(took < 1000, `took ${took}ms`);
  assert.deepEqual(f.sessions[0]!.calls.slice(0, 2), ['interrupt', 'close']);
  assert.equal(f.signals[0]!.aborted, true);
  await exec.warm();
  assert.equal(f.sessions.length, 2);
  assertValid(events);
});

test('openSession that never resolves: warm emits an error, phase1 rejects within the open timeout', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup({ openTimeoutMs: 50 });
  f.openGate = new Promise<void>(() => undefined);
  await exec.warm();
  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.equal(f.signals[0]!.aborted, true);
  const t0 = performance.now();
  await assert.rejects(exec.phase1('t1', belief()), SpeculationFailed);
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(f.signals[1]!.aborted, true);
  assert.equal(f.sessions.length, 0);
  assertValid(events);
});

test('openSession resolving after the open timeout: the late session is closed, not adopted', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup({ openTimeoutMs: 50 });
  let release: () => void = () => undefined;
  f.openGate = new Promise<void>((r) => (release = r));
  await exec.warm();
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.sessions.length, 1);
  assert.deepEqual(f.sessions[0]!.calls, ['close']);
  await exec.warm(); // not adopted: a fresh session opens
  assert.equal(f.sessions.length, 2);
  assert.deepEqual(f.sessions[1]!.calls, []);
});

const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('onStaged fires once, with the first early diff, before the turn ends', { timeout: 5000 }, async () => {
  const { f, events, exec } = setup();
  withMarker(f, events);
  await exec.phase1('t1', belief());
  f.phase2.push('early-changed');
  let stagedAt = -1;
  let count = 0;
  await exec.phase2('t1', belief(), {
    onStaged: () => {
      count++;
      stagedAt = events.length;
    },
  });
  assert.equal(count, 1);
  const firstDiff = events.indexOf(droid(events, 'diff')[0]!);
  assert.ok(firstDiff < stagedAt && stagedAt <= markerAt(events), 'onStaged after the first diff, before the turn ends');
  assertValid(events);
});

test('onStaged is not called when no write result arrives (diff only at turn end)', async () => {
  const { exec } = setup();
  await exec.phase1('t1', belief());
  let count = 0;
  await exec.phase2('t1', belief(), { onStaged: () => void count++ });
  assert.equal(count, 0);
});

test('commit during a blocked phase2 after an early diff lands exactly the staged content', { timeout: 5000 }, async () => {
  const { root, git, raw, f, events, exec } = setup();
  await exec.phase1('t1', belief());
  f.phase2.push('early-block');
  let staged = false;
  const p2 = exec.phase2('t1', belief(), { onStaged: () => void (staged = true) });
  await waitFor(() => staged);
  await exec.commit('t1');
  await p2; // resolves quietly, no throw
  assert.ok(f.sessions[0]!.calls.includes('interrupt'));
  assert.equal(await git.currentBranch(), 'main');
  assert.match(calendar(root), /2026-11-02T09:00:00-08:00/);
  assert.equal(await git.isClean(), true);
  assert.deepEqual(specBranches(raw), []);
  assert.equal(droid(events, 'diff').length, 1);
  assert.equal(droid(events, 'result').length, 0, 'superseded phase2 emits no result');
  assert.ok(!metrics(events).includes('phase2'));
  assert.ok(metrics(events).includes('commit'));
  assertValid(events);
});

test('a write that lands after staging but before commit is dropped', { timeout: 5000 }, async () => {
  const { root, git, raw, f, events, exec } = setup();
  await exec.phase1('t1', belief());
  f.phase2.push('early-block');
  let staged = false;
  const p2 = exec.phase2('t1', belief(), { onStaged: () => void (staged = true) });
  await waitFor(() => staged);
  // The turn keeps editing after the staged diff was shown.
  const cal = path.join(root, EVT);
  fs.writeFileSync(cal, fs.readFileSync(cal, 'utf8').replace('2026-11-02T09:00:00-08:00', '2026-11-02T08:30:00-08:00'));
  fs.writeFileSync(path.join(root, 'stray.txt'), 'late\n');
  await exec.commit('t1');
  await p2;
  assert.match(calendar(root), /2026-11-02T09:00:00-08:00/);
  assert.doesNotMatch(calendar(root), /08:30/);
  assert.equal(fs.existsSync(path.join(root, 'stray.txt')), false);
  assert.equal(await git.isClean(), true);
  assert.deepEqual(specBranches(raw), []);
  const shown = (droid(events, 'diff').at(-1)!.payload as { diff: string }).diff;
  assert.match(shown, /\+.*2026-11-02T09:00:00-08:00/);
  assertValid(events);
});

test('turn failure after staging emits result failed:true, throws, closes, keeps the staged branch', { timeout: 5000 }, async () => {
  const { root, git, raw, f, events, exec } = setup();
  await exec.phase1('t1', belief());
  f.phase2.push('early-fail');
  let staged = 0;
  await assert.rejects(exec.phase2('t1', belief(), { onStaged: () => void staged++ }), SpeculationFailed);
  assert.equal(staged, 1);
  const results = droid(events, 'result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.payload, { ok: false, failed: true, summary: 'droid turn failed after staging' });
  assert.ok(events.indexOf(droid(events, 'diff')[0]!) < events.indexOf(results[0]!));
  assert.ok(f.sessions[0]!.calls.includes('close'));
  assert.deepEqual(specBranches(raw), ['spec/t1']);
  assert.equal(await git.currentBranch(), 'spec/t1');
  // The staged diff can still be applied.
  await exec.commit('t1');
  assert.match(calendar(root), /2026-11-02T09:00:00-08:00/);
  assert.equal(await git.isClean(), true);
  assert.deepEqual(specBranches(raw), []);
  assertValid(events);
});

const corrected = (): Belief => ({
  ...belief('draft_message'),
  entities: { person: 'Priya', day: 'friday', superseded_day: 'thursday' },
});
const outboxDiffs = (events: ServerEvent[]) => droid(events, 'diff').map((e) => (e.payload as { diff: string }).diff);

test('post-check: a draft naming the superseded day is not staged; one rerun fixes it', async () => {
  const { root, f, events, exec } = setup();
  await exec.phase1('t1', corrected());
  f.phase2.push('draft-thursday', 'draft-friday');
  let staged = 0;
  await exec.phase2('t1', corrected(), { onStaged: () => void staged++ });
  const prompts = f.sessions[0]!.prompts;
  assert.equal(prompts.length, 3);
  assert.match(prompts[1]!, /^Correction: the user originally said thursday, this was corrected to friday\./m);
  assert.match(prompts[2]!, /still mentions a value the user corrected/);
  assert.equal(staged, 1);
  assert.ok(outboxDiffs(events).every((d) => !/Thursday/.test(d)), 'no Thursday diff shown');
  assert.ok(outboxDiffs(events).some((d) => /\+Hi Priya, see you Friday at 2\./.test(d)));
  assert.ok(metrics(events).includes('phase2-reject'));
  assert.deepEqual(droid(events, 'result').map((e) => (e.payload as { ok: boolean }).ok), [true]);
  await exec.commit('t1');
  assert.match(fs.readFileSync(path.join(root, 'messages', 'outbox', 'priya.md'), 'utf8'), /Friday/);
  assertValid(events);
});

test('post-check: a draft still naming the superseded day after the rerun fails phase2 and stages nothing', async () => {
  const { f, events, exec } = setup();
  await exec.phase1('t1', corrected());
  f.phase2.push('draft-thursday', 'draft-thursday');
  let staged = 0;
  await assert.rejects(exec.phase2('t1', corrected(), { onStaged: () => void staged++ }), SpeculationFailed);
  assert.equal(f.sessions[0]!.prompts.length, 3);
  assert.equal(staged, 0);
  assert.deepEqual(outboxDiffs(events), []);
  assertValid(events);
});

test('post-check: without an accepted correction the same draft stages with no rerun', async () => {
  const { f, events, exec } = setup();
  await exec.phase1('t1', belief('draft_message'));
  f.phase2.push('draft-thursday');
  let staged = 0;
  await exec.phase2('t1', belief('draft_message'), { onStaged: () => void staged++ });
  assert.equal(f.sessions[0]!.prompts.length, 2);
  assert.equal(staged, 1);
  assert.ok(!metrics(events).includes('phase2-reject'));
});

test('phase1 hands Droid the one event file the belief points at, and phase2 edits that file', async () => {
  const { f, exec } = setup();
  const b: Belief = { ...belief(), entities: { event: 'Q3 deck review with Priya' }, topHits: [{ docId: 'evt-priya-q3', score: 0.5, snippet: '' }] };
  await exec.phase1('t1', b);
  await exec.phase2('t1', b);
  const [p1, p2] = f.sessions[0]!.prompts;
  assert.match(p1!, /Open only this file: Read `calendar\/evt-priya-q3\.json` and no other file under calendar\//);
  assert.doesNotMatch(p1!, /index\.json/);
  assert.match(p2!, /Make the edit now in `calendar\/evt-priya-q3\.json`\./);
});

test('phase1 without a resolvable event falls back to calendar/index.json', async () => {
  const { f, exec } = setup();
  await exec.phase1('t1', belief());
  assert.match(f.sessions[0]!.prompts[0]!, /Read `calendar\/index\.json`/);
});

test('draft phase1 passes the one contact inline instead of contacts.json', async () => {
  const { f, exec } = setup();
  await exec.phase1('t1', { ...belief('draft_message'), entities: { person: 'Priya' } });
  const p1 = f.sessions[0]!.prompts[0]!;
  assert.match(p1, /The recipient is this contact from contacts\.json \(do not open contacts\.json\): \{.*"name":"Priya Shah"/);
  assert.doesNotMatch(p1, /Read contacts\.json/);
});
