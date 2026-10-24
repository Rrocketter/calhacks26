import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Belief, Intent } from '@ahead/contracts';
import { initial, transition, type Effect, type SmCtx, type SmEvent } from './state-machine.js';

const b = (intent: Intent, confidence: number): Belief => ({
  intent,
  entities: {},
  claims: [],
  confidence,
  topHits: [],
  latencyMs: { moss: 1 },
});

// Feeds events in order, returns final ctx and the effects of the last event.
function run(events: SmEvent[], from: SmCtx = initial()) {
  let ctx = from;
  let effects: Effect[] = [];
  for (const ev of events) ({ ctx, effects } = transition(ctx, ev));
  return { ctx, effects };
}
const types = (effects: Effect[]) => effects.map((e) => (e.type === 'state' ? `state:${e.state}` : e.type));
const start: SmEvent = { type: 'turn_start', turnId: 't1' };

test('turn_start from initial goes to LISTENING with turnId and only a state effect', () => {
  const { ctx, effects } = run([start]);
  assert.equal(ctx.state, 'LISTENING');
  assert.equal(ctx.turnId, 't1');
  assert.deepEqual(types(effects), ['state:LISTENING']);
});

test('low-confidence beliefs move to BELIEF_FORMING without phase1', () => {
  let r = run([start, { type: 'belief', belief: b('unknown', 0.1) }]);
  assert.equal(r.ctx.state, 'BELIEF_FORMING');
  assert.deepEqual(types(r.effects), ['state:BELIEF_FORMING']);
  r = run([{ type: 'belief', belief: b('draft_message', 0.55) }], r.ctx);
  assert.equal(r.ctx.state, 'BELIEF_FORMING');
  assert.deepEqual(types(r.effects), []);
});

test('locking belief goes to SPECULATING with [phase1, state]', () => {
  const forming = run([start, { type: 'belief', belief: b('draft_message', 0.55) }]).ctx;
  const bel = b('draft_message', 0.78);
  const r = run([{ type: 'belief', belief: bel }], forming);
  assert.equal(r.ctx.state, 'SPECULATING');
  assert.deepEqual(r.effects, [{ type: 'phase1', belief: bel }, { type: 'state', state: 'SPECULATING' }]);
  assert.equal(r.ctx.locked, bel);
});

test('first belief already at lock confidence emits both state changes in order', () => {
  const bel = b('add_note', 0.8);
  const r = run([start, { type: 'belief', belief: bel }]);
  assert.deepEqual(r.effects, [
    { type: 'state', state: 'BELIEF_FORMING' },
    { type: 'phase1', belief: bel },
    { type: 'state', state: 'SPECULATING' },
  ]);
});

const speculating = (intent: Intent = 'draft_message') =>
  run([start, { type: 'belief', belief: b(intent, 0.78) }]).ctx;

test('same-intent beliefs while SPECULATING emit no phase1 and update latest', () => {
  let ctx = speculating();
  for (const c of [0.74, 0.79, 0.86]) {
    const bel = b('draft_message', c);
    const r = run([{ type: 'belief', belief: bel }], ctx);
    assert.deepEqual(r.effects, []);
    assert.equal(r.ctx.latest, bel);
    assert.equal(r.ctx.state, 'SPECULATING');
    ctx = r.ctx;
  }
});

test('lookup never dispatches from BELIEF_FORMING', () => {
  const forming = run([start, { type: 'belief', belief: b('unknown', 0.1) }]).ctx;
  const r = run([{ type: 'belief', belief: b('lookup', 0.9) }], forming);
  assert.equal(r.ctx.state, 'BELIEF_FORMING');
  assert.deepEqual(r.effects, []);
});

test('diverging intent while SPECULATING rolls back, then a new lock speculates again', () => {
  let r = run([{ type: 'belief', belief: b('find_file', 0.8) }], speculating());
  assert.deepEqual(types(r.effects), ['rollback', 'state:ROLLED_BACK', 'warm']);
  assert.equal(r.ctx.state, 'ROLLED_BACK');
  const next = b('add_note', 0.9);
  r = run([{ type: 'belief', belief: next }], r.ctx);
  assert.deepEqual(r.effects, [{ type: 'phase1', belief: next }, { type: 'state', state: 'SPECULATING' }]);
  assert.equal(r.ctx.locked, next);
});

test('unknown intent while SPECULATING changes nothing', () => {
  const r = run([{ type: 'belief', belief: b('unknown', 0.2) }], speculating());
  assert.equal(r.ctx.state, 'SPECULATING');
  assert.deepEqual(r.effects, []);
});

test('eager_end in SPECULATING sends phase2 with latest; not sent twice', () => {
  const latest = b('draft_message', 0.9);
  const ctx = run([{ type: 'belief', belief: latest }], speculating()).ctx;
  let r = run([{ type: 'eager_end' }], ctx);
  assert.deepEqual(r.effects, [{ type: 'phase2', belief: latest }]);
  assert.equal(r.ctx.phase2Sent, true);
  r = run([{ type: 'eager_end' }], r.ctx);
  assert.deepEqual(r.effects, []);
});

test('eager_end in BELIEF_FORMING does nothing', () => {
  const forming = run([start, { type: 'belief', belief: b('draft_message', 0.5) }]).ctx;
  const r = run([{ type: 'eager_end' }], forming);
  assert.deepEqual(r.effects, []);
  assert.equal(r.ctx.phase2Sent, false);
});

const sent = () => run([{ type: 'eager_end' }], speculating()).ctx;

test('phase2_done moves to STAGED', () => {
  const r = run([{ type: 'phase2_done' }], sent());
  assert.equal(r.ctx.state, 'STAGED');
  assert.deepEqual(types(r.effects), ['state:STAGED']);
});

test('phase2_done without phase2Sent is ignored (stale)', () => {
  const r = run([{ type: 'phase2_done' }], speculating());
  assert.equal(r.ctx.state, 'SPECULATING');
  assert.deepEqual(r.effects, []);
});

test('resume from STAGED resets phase1 and returns to SPECULATING', () => {
  const staged = run([{ type: 'phase2_done' }], sent()).ctx;
  const r = run([{ type: 'resume' }], staged);
  assert.deepEqual(types(r.effects), ['reset_phase1', 'state:SPECULATING']);
  assert.equal(r.ctx.state, 'SPECULATING');
  assert.equal(r.ctx.phase2Sent, false);
});

test('resume with phase2 in flight resets phase1', () => {
  const r = run([{ type: 'resume' }], sent());
  assert.deepEqual(types(r.effects), ['reset_phase1', 'state:SPECULATING']);
  assert.equal(r.ctx.phase2Sent, false);
});

test('resume before phase2 does nothing', () => {
  const r = run([{ type: 'resume' }], speculating());
  assert.deepEqual(r.effects, []);
});

test('phase2_done after resume is ignored', () => {
  const resumed = run([{ type: 'resume' }], sent()).ctx;
  const r = run([{ type: 'phase2_done' }], resumed);
  assert.equal(r.ctx.state, 'SPECULATING');
  assert.deepEqual(r.effects, []);
});

test('turn_end in SPECULATING before phase2 with matching intent sends phase2', () => {
  const bel = b('draft_message', 0.85);
  const r = run([{ type: 'turn_end', belief: bel }], speculating());
  assert.deepEqual(r.effects, [{ type: 'phase2', belief: bel }]);
  assert.equal(r.ctx.phase2Sent, true);
  assert.equal(r.ctx.turnEnded, true);
});

test('turn_end with null belief uses ctx.latest', () => {
  const latest = b('draft_message', 0.9);
  const ctx = run([{ type: 'belief', belief: latest }], speculating()).ctx;
  const r = run([{ type: 'turn_end', belief: null }], ctx);
  assert.deepEqual(r.effects, [{ type: 'phase2', belief: latest }]);
});

test('turn_end with diverged intent rolls back', () => {
  const r = run([{ type: 'turn_end', belief: b('find_file', 0.8) }], speculating());
  assert.deepEqual(types(r.effects), ['rollback', 'state:ROLLED_BACK', 'warm']);
  assert.equal(r.ctx.state, 'ROLLED_BACK');
});

test('turn_end in STAGED with matching intent waits for confirm but marks turnEnded', () => {
  const staged = run([{ type: 'phase2_done' }], sent()).ctx;
  const r = run([{ type: 'turn_end', belief: b('draft_message', 0.9) }], staged);
  assert.deepEqual(r.effects, []);
  assert.equal(r.ctx.state, 'STAGED');
  assert.equal(r.ctx.turnEnded, true);
});

test('turn_end in STAGED with diverged intent rolls back', () => {
  const staged = run([{ type: 'phase2_done' }], sent()).ctx;
  const r = run([{ type: 'turn_end', belief: b('add_note', 0.9) }], staged);
  assert.deepEqual(types(r.effects), ['rollback', 'state:ROLLED_BACK', 'warm']);
});

test('turn_end in BELIEF_FORMING or ROLLED_BACK does nothing', () => {
  const forming = run([start, { type: 'belief', belief: b('draft_message', 0.5) }]).ctx;
  let r = run([{ type: 'turn_end', belief: null }], forming);
  assert.deepEqual(r.effects, []);
  assert.equal(r.ctx.turnEnded, true);
  const rolled = run([{ type: 'belief', belief: b('find_file', 0.8) }], speculating()).ctx;
  r = run([{ type: 'turn_end', belief: null }], rolled);
  assert.deepEqual(r.effects, []);
});

test('confirm apply:true in STAGED commits', () => {
  const staged = run([{ type: 'phase2_done' }], sent()).ctx;
  const r = run([{ type: 'confirm', apply: true }], staged);
  assert.deepEqual(types(r.effects), ['commit', 'state:COMMITTED', 'warm']);
  assert.equal(r.ctx.state, 'COMMITTED');
});

test('confirm apply:false in STAGED rolls back', () => {
  const staged = run([{ type: 'phase2_done' }], sent()).ctx;
  const r = run([{ type: 'confirm', apply: false }], staged);
  assert.deepEqual(types(r.effects), ['rollback', 'state:ROLLED_BACK', 'warm']);
});

test('confirm apply:true in SPECULATING is held, then committed when phase2_done arrives', () => {
  let r = run([{ type: 'confirm', apply: true }], sent());
  assert.deepEqual(r.effects, []);
  assert.equal(r.ctx.pendingApply, true);
  assert.equal(r.ctx.state, 'SPECULATING');
  r = run([{ type: 'phase2_done' }], r.ctx);
  assert.deepEqual(types(r.effects), ['state:STAGED', 'commit', 'state:COMMITTED', 'warm']);
  assert.equal(r.ctx.state, 'COMMITTED');
  assert.equal(r.ctx.pendingApply, null);
});

test('confirm apply:false in SPECULATING rolls back immediately', () => {
  const r = run([{ type: 'confirm', apply: false }], sent());
  assert.deepEqual(types(r.effects), ['rollback', 'state:ROLLED_BACK', 'warm']);
});

test('confirm outside SPECULATING/STAGED does nothing', () => {
  const forming = run([start, { type: 'belief', belief: b('draft_message', 0.5) }]).ctx;
  assert.deepEqual(run([{ type: 'confirm', apply: true }], forming).effects, []);
  assert.deepEqual(run([{ type: 'confirm', apply: false }], initial()).effects, []);
});

test('failed in SPECULATING or STAGED rolls back', () => {
  const staged = run([{ type: 'phase2_done' }], sent()).ctx;
  for (const ctx of [speculating(), staged]) {
    const r = run([{ type: 'failed' }], ctx);
    assert.deepEqual(types(r.effects), ['rollback', 'state:ROLLED_BACK', 'warm']);
    assert.equal(r.ctx.locked, null);
    assert.equal(r.ctx.phase2Sent, false);
  }
});

test('failed in other states does nothing', () => {
  const forming = run([start, { type: 'belief', belief: b('draft_message', 0.5) }]).ctx;
  assert.deepEqual(run([{ type: 'failed' }], forming).effects, []);
});

test('COMMITTED ignores everything except turn_start', () => {
  const committed = run([{ type: 'confirm', apply: true }, { type: 'phase2_done' }], sent()).ctx;
  assert.equal(committed.state, 'COMMITTED');
  const evs: SmEvent[] = [
    { type: 'belief', belief: b('find_file', 0.9) },
    { type: 'eager_end' },
    { type: 'resume' },
    { type: 'turn_end', belief: b('find_file', 0.9) },
    { type: 'phase2_done' },
    { type: 'failed' },
    { type: 'confirm', apply: false },
  ];
  for (const ev of evs) {
    const r = run([ev], committed);
    assert.deepEqual(r.effects, [], ev.type);
    assert.equal(r.ctx.state, 'COMMITTED');
  }
});

test('turn_start resets ctx from any state', () => {
  const r = run([{ type: 'turn_start', turnId: 't2' }], sent());
  assert.deepEqual(r.ctx, { ...initial(), turnId: 't2' });
  assert.deepEqual(types(r.effects), ['state:LISTENING']);
});

test('events before any turn_start are ignored', () => {
  const r = run([{ type: 'belief', belief: b('draft_message', 0.9) }]);
  assert.deepEqual(r.effects, []);
  assert.deepEqual(r.ctx, initial());
});

test('transition does not mutate its input ctx', () => {
  const ctx = speculating();
  const snapshot = structuredClone(ctx);
  for (const ev of [
    { type: 'eager_end' },
    { type: 'confirm', apply: true },
    { type: 'turn_end', belief: b('find_file', 0.9) },
    { type: 'belief', belief: b('add_note', 0.9) },
  ] as SmEvent[]) {
    transition(ctx, ev);
    assert.deepEqual(ctx, snapshot);
  }
});
