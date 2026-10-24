import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerEvent, type Belief, type ServerEvent, type State } from '@ahead/contracts';
import { mockBeliefStream, mockDroidRun } from '@ahead/contracts/mocks';
import { Speculator } from './speculator.js';
import { SpeculationFailed, type Executor } from './types.js';

type Call = { name: string; args: unknown[] };
type Opts = {
  withDenied?: boolean;
  phase2?: (turnId: string, hooks?: { onStaged?: () => void }) => Promise<void>;
  commit?: (turnId: string) => Promise<void>;
  rollback?: (turnId: string) => Promise<void>;
};

function setup(opts: Opts = {}) {
  const calls: Call[] = [];
  const events: ServerEvent[] = [];
  const emit = (ev: ServerEvent) => void events.push(ev);
  const rec = (name: string, args: unknown[]) => calls.push({ name, args });
  const executor: Executor = {
    warm: async () => void rec('warm', []),
    phase1: async (t, b) => void rec('phase1', [t, b.intent]),
    phase2: async (t, b, hooks) => {
      rec('phase2', [t, b.intent]);
      if (opts.phase2) return opts.phase2(t, hooks);
      for await (const ev of mockDroidRun(t, { withDenied: opts.withDenied })) emit(ev);
    },
    resetToPhase1: async (t) => void rec('resetToPhase1', [t]),
    commit: async (t) => {
      rec('commit', [t]);
      if (opts.commit) return opts.commit(t);
    },
    rollback: async (t) => {
      rec('rollback', [t]);
      if (opts.rollback) return opts.rollback(t);
    },
  };
  const spec = new Speculator(executor, emit);
  const names = () => calls.map((c) => c.name);
  const states = () => events.flatMap((e) => (e.type === 'state_change' ? [e.state] : []));
  return { spec, calls, events, names, states };
}

const belief = (intent: Belief['intent'], confidence: number): Belief => ({
  intent,
  entities: {},
  claims: [],
  confidence,
  topHits: [],
  latencyMs: { moss: 1 },
});
const bu = (turnId: string, b: Belief): ServerEvent => ({ type: 'belief_update', turnId, belief: b });
const ev = (type: 'turn_start' | 'turn_eager_end' | 'turn_resume' | 'turn_end', turnId: string) =>
  ({ type, turnId, ts: 0 }) as unknown as ServerEvent;

async function happyPath(withDenied: boolean) {
  const s = setup({ withDenied });
  s.spec.start();
  s.spec.onServerEvent(ev('turn_start', 't1'));
  for await (const e of mockBeliefStream('t1', { speed: 20 })) s.spec.onServerEvent(e);
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  s.spec.onServerEvent(ev('turn_end', 't1'));
  await s.spec.idle();
  s.spec.onConfirm('t1', true);
  await s.spec.idle();
  return s;
}

test('happy path: calls, states, forwarded droid events', async () => {
  const s = await happyPath(false);
  assert.deepEqual(s.names(), ['warm', 'phase1', 'phase2', 'commit', 'warm']);
  assert.deepEqual(s.calls[1]?.args, ['t1', 'draft_message']);
  assert.deepEqual(s.states(), ['LISTENING', 'BELIEF_FORMING', 'SPECULATING', 'STAGED', 'COMMITTED'] satisfies State[]);
  assert.ok(s.events.some((e) => e.type === 'droid_event' && e.kind === 'diff'));
  for (const e of s.events) parseServerEvent(JSON.stringify(e));
});

test('denied droid event forwarded unchanged', async () => {
  const s = await happyPath(true);
  assert.ok(s.events.some((e) => e.type === 'droid_event' && e.kind === 'tool' && e.denied === true));
  for (const e of s.events) parseServerEvent(JSON.stringify(e));
});

test('divergence to lookup rolls back without phase2', async () => {
  const s = setup();
  s.spec.start();
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('find_file', 0.8)));
  s.spec.onServerEvent(bu('t1', belief('lookup', 0.9)));
  await s.spec.idle();
  assert.ok(s.names().includes('rollback'));
  assert.ok(!s.names().includes('phase2'));
  assert.ok(s.states().includes('ROLLED_BACK'));
});

test('resume after eager end resets to phase 1', async () => {
  const s = setup({ phase2: () => new Promise(() => undefined) });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  s.spec.onServerEvent(ev('turn_resume', 't1'));
  assert.deepEqual(s.names(), ['phase1', 'phase2', 'resetToPhase1']);
  assert.deepEqual(s.states(), ['LISTENING', 'BELIEF_FORMING', 'SPECULATING', 'SPECULATING']);
});

test('phase2 SpeculationFailed rolls back then warms', async () => {
  const s = setup({ phase2: async () => Promise.reject(new SpeculationFailed('boom')) });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  await s.spec.idle();
  assert.deepEqual(s.names(), ['phase1', 'phase2', 'rollback', 'warm']);
  assert.equal(s.states().at(-1), 'ROLLED_BACK');
  assert.ok(!s.events.some((e) => e.type === 'error'));
});

test('other rejection emits error and rolls back', async () => {
  const s = setup({ phase2: async () => Promise.reject(new Error('kaput')) });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  await s.spec.idle();
  const err = s.events.find((e) => e.type === 'error');
  assert.ok(err && err.type === 'error' && err.source === 'droid' && err.message.includes('kaput'));
  assert.equal(s.states().at(-1), 'ROLLED_BACK');
  for (const e of s.events) parseServerEvent(JSON.stringify(e));
});

test('R19: stale first phase2 resolving after a second phase2 does not stage (fallback staged)', async () => {
  const releases: (() => void)[] = [];
  const s = setup({ phase2: () => new Promise<void>((r) => releases.push(r)) });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  s.spec.onServerEvent(ev('turn_resume', 't1'));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  assert.equal(releases.length, 2);
  releases[0]?.();
  await new Promise((r) => setImmediate(r));
  assert.ok(!s.states().includes('STAGED'));
  releases[1]?.();
  await s.spec.idle();
  assert.equal(s.states().at(-1), 'STAGED');
});

test('events for another turnId are ignored', async () => {
  const s = setup();
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t0', belief('draft_message', 0.9)));
  s.spec.onServerEvent(ev('turn_eager_end', 't0'));
  s.spec.onServerEvent(ev('turn_end', 't0'));
  s.spec.onConfirm('t0', true);
  await s.spec.idle();
  assert.deepEqual(s.names(), []);
  assert.deepEqual(s.states(), ['LISTENING']);
});

test('late results from a previous turn do not touch the new turn', async () => {
  let failP1: (e: Error) => void = () => undefined;
  let finish2: () => void = () => undefined;
  const calls: string[] = [];
  const events: ServerEvent[] = [];
  const executor: Executor = {
    warm: async () => undefined,
    phase1: (t) => (t === 't1' ? new Promise<void>((_, rej) => (failP1 = rej)) : Promise.resolve()),
    phase2: (t) => (t === 't1' ? new Promise<void>((res) => (finish2 = res)) : new Promise<void>(() => undefined)),
    resetToPhase1: async () => undefined,
    commit: async (t) => void calls.push(`commit ${t}`),
    rollback: async (t) => void calls.push(`rollback ${t}`),
  };
  const spec = new Speculator(executor, (e) => void events.push(e));
  spec.onServerEvent(ev('turn_start', 't1'));
  spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  spec.onServerEvent(ev('turn_eager_end', 't1'));
  spec.onServerEvent(ev('turn_start', 't2'));
  spec.onServerEvent(bu('t2', belief('find_file', 0.8))); // t2 is SPECULATING, phase2 not sent
  calls.length = 0;
  const before = events.length;
  failP1(new SpeculationFailed('late'));
  finish2();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, []);
  assert.deepEqual(events.slice(before), []);
});

test('confirm during phase2 commits after it resolves', async () => {
  let release: () => void = () => undefined;
  const s = setup({ phase2: () => new Promise<void>((r) => (release = r)) });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  s.spec.onConfirm('t1', true);
  release();
  await s.spec.idle();
  assert.deepEqual(s.names(), ['phase1', 'phase2', 'commit', 'warm']);
  assert.deepEqual(s.states().slice(-2), ['STAGED', 'COMMITTED']);
});

test('synchronous throw from an executor method is handled and the batch continues', async () => {
  const calls: string[] = [];
  const events: ServerEvent[] = [];
  const executor: Executor = {
    warm: async () => void calls.push('warm'),
    phase1: () => { throw new Error('sync boom'); },
    phase2: async () => undefined,
    resetToPhase1: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  const spec = new Speculator(executor, (e) => void events.push(e));
  spec.onServerEvent(ev('turn_start', 't1'));
  spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  await spec.idle();
  assert.ok(events.some((e) => e.type === 'error' && e.message.includes('sync boom')));
  // the state effect after phase1 in the same batch still ran, then failed rolled it back
  assert.deepEqual(
    events.flatMap((e) => (e.type === 'state_change' ? [e.state] : [])),
    ['LISTENING', 'BELIEF_FORMING', 'SPECULATING', 'ROLLED_BACK'],
  );
  assert.deepEqual(calls, ['warm']);
});

test('no unhandled rejections from failing executor methods', async () => {
  const seen: unknown[] = [];
  const h = (r: unknown) => void seen.push(r);
  process.on('unhandledRejection', h);
  try {
    const fail = () => Promise.reject(new Error('x'));
    const events: ServerEvent[] = [];
    const executor: Executor = {
      warm: fail, phase1: fail, phase2: fail, resetToPhase1: fail, commit: fail, rollback: fail,
    };
    const spec = new Speculator(executor, (e) => void events.push(e));
    spec.start();
    spec.onServerEvent(ev('turn_start', 't1'));
    spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
    spec.onServerEvent(ev('turn_eager_end', 't1'));
    // no idle(): allSettled would attach handlers and mask a missing catch
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, []);
    assert.ok(events.some((e) => e.type === 'error'));
  } finally {
    process.off('unhandledRejection', h);
  }
});

const errors = (events: ServerEvent[]) => events.flatMap((e) => (e.type === 'error' ? [e] : []));

test('commit rejecting with SpeculationFailed emits one error event "commit failed"', async () => {
  const s = setup({ commit: () => Promise.reject(new SpeculationFailed('git merge failed')) });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  await s.spec.idle();
  s.spec.onConfirm('t1', true);
  await s.spec.idle();
  assert.ok(s.names().includes('commit'));
  assert.deepEqual(errors(s.events), [{ type: 'error', source: 'droid', message: 'commit failed' }]);
  for (const e of s.events) parseServerEvent(JSON.stringify(e));
});

test('rollback rejecting with SpeculationFailed emits one error event "rollback failed"', async () => {
  const s = setup({ rollback: () => Promise.reject(new SpeculationFailed('git discard failed')) });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  await s.spec.idle();
  s.spec.onConfirm('t1', false);
  await s.spec.idle();
  assert.ok(s.names().includes('rollback'));
  assert.deepEqual(errors(s.events), [{ type: 'error', source: 'droid', message: 'rollback failed' }]);
  for (const e of s.events) parseServerEvent(JSON.stringify(e));
});

test('non-SpeculationFailed error messages are redacted of env values', async (t) => {
  const secret = 'sk-test-0123456789abcdef';
  process.env.AHEAD_TEST_SECRET = secret;
  t.after(() => void delete process.env.AHEAD_TEST_SECRET);
  const events: ServerEvent[] = [];
  const executor: Executor = {
    warm: () => Promise.reject(new Error(`bad key ${secret}`)),
    phase1: async () => undefined, phase2: async () => undefined, resetToPhase1: async () => undefined,
    commit: async () => undefined, rollback: async () => undefined,
  };
  const spec = new Speculator(executor, (e) => void events.push(e));
  spec.start();
  await spec.idle();
  const errs = errors(events);
  assert.equal(errs.length, 1);
  assert.ok(!errs[0]!.message.includes(secret));
  assert.match(errs[0]!.message, /^warm: bad key \[redacted\]$/);
});

const tick = () => new Promise((r) => setImmediate(r));
// A phase2 that hands its onStaged hook out and stays pending until released or failed.
function heldPhase2() {
  const h: { onStaged: () => void; release: () => void; fail: (e: Error) => void } = {
    onStaged: () => undefined,
    release: () => undefined,
    fail: () => undefined,
  };
  const phase2 = (_t: string, hooks?: { onStaged?: () => void }) =>
    new Promise<void>((res, rej) => {
      h.onStaged = () => hooks?.onStaged?.();
      h.release = () => res();
      h.fail = (e) => rej(e);
    });
  return { h, phase2 };
}

test('STAGED is emitted on onStaged, before the phase2 promise settles', async () => {
  const { h, phase2 } = heldPhase2();
  const s = setup({ phase2 });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('reschedule_event', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  assert.equal(s.states().at(-1), 'SPECULATING');
  h.onStaged();
  assert.equal(s.states().at(-1), 'STAGED');
  h.onStaged(); // repeated hook: no second STAGED
  h.release();
  await s.spec.idle();
  assert.deepEqual(s.states(), ['LISTENING', 'BELIEF_FORMING', 'SPECULATING', 'STAGED']);
  for (const e of s.events) parseServerEvent(JSON.stringify(e));
});

test('fallback: phase2 resolving with no edit (no onStaged) still stages', async () => {
  const { h, phase2 } = heldPhase2();
  const s = setup({ phase2 });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('find_file', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  await tick();
  assert.ok(!s.states().includes('STAGED'));
  h.release();
  await s.spec.idle();
  assert.equal(s.states().at(-1), 'STAGED');
  assert.equal(s.states().filter((x) => x === 'STAGED').length, 1);
});

test('failure after staging: no ROLLED_BACK, no rollback call, no error event', async () => {
  const { h, phase2 } = heldPhase2();
  const s = setup({ phase2 });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('reschedule_event', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  h.onStaged();
  h.fail(new SpeculationFailed('phase2 error'));
  await s.spec.idle();
  assert.ok(!s.names().includes('rollback'));
  assert.ok(!s.states().includes('ROLLED_BACK'));
  assert.equal(s.states().at(-1), 'STAGED');
  assert.deepEqual(errors(s.events), []);
  // The staged diff can still be applied.
  s.spec.onConfirm('t1', true);
  await s.spec.idle();
  assert.equal(s.states().at(-1), 'COMMITTED');
});

test('confirm apply:true in STAGED while phase2 is pending commits right away', async () => {
  const { h, phase2 } = heldPhase2();
  const s = setup({ phase2 });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('reschedule_event', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  h.onStaged();
  s.spec.onConfirm('t1', true);
  assert.deepEqual(s.names(), ['phase1', 'phase2', 'commit', 'warm']);
  assert.deepEqual(s.states().slice(-2), ['STAGED', 'COMMITTED']);
  h.release();
  await s.spec.idle();
  assert.deepEqual(s.names(), ['phase1', 'phase2', 'commit', 'warm']);
});

test('R19: onStaged from a phase2 superseded by resume does not stage', async () => {
  const held: ReturnType<typeof heldPhase2>[] = [];
  const s = setup({
    phase2: (t, hooks) => {
      const x = heldPhase2();
      held.push(x);
      return x.phase2(t, hooks);
    },
  });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('reschedule_event', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  s.spec.onServerEvent(ev('turn_resume', 't1'));
  held[0]!.h.onStaged();
  held[0]!.h.release();
  await tick();
  assert.ok(!s.states().includes('STAGED'));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  held[1]!.h.onStaged();
  assert.equal(s.states().at(-1), 'STAGED');
  held[1]!.h.release();
  await s.spec.idle();
});
