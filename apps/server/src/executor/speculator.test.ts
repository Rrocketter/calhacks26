import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerEvent, type Belief, type ServerEvent, type State } from '@ahead/contracts';
import { mockBeliefStream, mockDroidRun } from '@ahead/contracts/mocks';
import { Speculator } from './speculator.js';
import { SpeculationFailed, type Executor } from './types.js';

type Call = { name: string; args: unknown[] };
type Opts = { withDenied?: boolean; phase2?: (turnId: string) => Promise<void> };

function setup(opts: Opts = {}) {
  const calls: Call[] = [];
  const events: ServerEvent[] = [];
  const emit = (ev: ServerEvent) => void events.push(ev);
  const rec = (name: string, args: unknown[]) => calls.push({ name, args });
  const executor: Executor = {
    warm: async () => void rec('warm', []),
    phase1: async (t, b) => void rec('phase1', [t, b.intent]),
    phase2: async (t, b) => {
      rec('phase2', [t, b.intent]);
      if (opts.phase2) return opts.phase2(t);
      for await (const ev of mockDroidRun(t, { withDenied: opts.withDenied })) emit(ev);
    },
    resetToPhase1: async (t) => void rec('resetToPhase1', [t]),
    commit: async (t) => void rec('commit', [t]),
    rollback: async (t) => void rec('rollback', [t]),
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

test('R19: phase2 resolving after reset_phase1 does not stage', async () => {
  let release: () => void = () => undefined;
  const s = setup({ phase2: () => new Promise<void>((r) => (release = r)) });
  s.spec.onServerEvent(ev('turn_start', 't1'));
  s.spec.onServerEvent(bu('t1', belief('draft_message', 0.8)));
  s.spec.onServerEvent(ev('turn_eager_end', 't1'));
  s.spec.onServerEvent(ev('turn_resume', 't1'));
  release();
  await s.spec.idle();
  assert.ok(!s.states().includes('STAGED'));
  assert.equal(s.states().at(-1), 'SPECULATING');
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
    await spec.idle();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, []);
    assert.ok(events.some((e) => e.type === 'error'));
  } finally {
    process.off('unhandledRejection', h);
  }
});
