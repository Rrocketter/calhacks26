import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Belief, Claim, ClientEvent, MossHit, RetrievalMode, ServerEvent, State } from '@ahead/contracts';
import { CONFIRM_WINDOW_MS, CORRECTION_TIMEOUT_MS, Orchestrator, type TrackerPort } from './orchestrator.js';
import { APPLIED_REPLY, DISCARDED_REPLY, FALLBACK_REPLY } from './reply.js';
import type { MemoryDoc } from './moss/memory.js';

type Call = { name: string; args: unknown[] };
type Opts = {
  tracker?: boolean;
  demo?: boolean;
  answer?: (q: string, hits: MossHit[], today?: Date) => Promise<string>;
  upcoming?: (text: string, todayIso: string) => Promise<MossHit[]>;
  /** Belief returned by tracker.onTurnEnd, per turn. */
  finalBelief?: (turnId: string) => Belief;
  /** When true, tracker.onTurnEnd also emits the final belief as a belief_update (like the real tracker). */
  emitFinal?: boolean;
  correctionTimeoutMs?: number;
  confirmWindowMs?: number;
  /** Speculator fake answers onConfirm with COMMITTED / ROLLED_BACK synchronously. */
  autoState?: boolean;
  /** tracker.onTurnEnd waits for this before resolving (a slow final Haiku call). */
  gate?: Promise<void>;
  /** tracker.onEagerEnd waits for this before resolving (the eager text's Moss step). */
  eagerGate?: Promise<void>;
  /** Record memory writes in `mem`. */
  memory?: boolean;
  /** The tracker's switchable retriever. */
  retrieval?: { mode: RetrievalMode; readonly delayMs: number };
};

const belief = (intent: Belief['intent'], entities: Record<string, string> = {}, claims: Claim[] = []): Belief => ({
  intent,
  entities,
  claims,
  confidence: 0.9,
  topHits: [{ docId: 'd1', score: 0.9, snippet: 'snippet one' }],
  latencyMs: { moss: 1 },
});

const DAY_CLAIM: Claim = { field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-priya-q3' };
const INTERJECT = 'Say Friday?';

function setup(opts: Opts = {}) {
  const calls: Call[] = [];
  const ws: ServerEvent[] = [];
  const specEvents: ServerEvent[] = [];
  const spoken: { text: string; opts: { interrupt: boolean; turnId: string } }[] = [];
  const mem: MemoryDoc[] = [];
  const rec = (name: string, args: unknown[]) => calls.push({ name, args });
  const tracker: TrackerPort = {
    onUpdate: async (t, text) => void rec('tracker.onUpdate', [t, text]),
    onEagerEnd: async (t, text) => {
      rec('tracker.onEagerEnd', [t, text]);
      if (opts.eagerGate) await opts.eagerGate;
    },
    onResume: (t) => void rec('tracker.onResume', [t]),
    onTurnEnd: async (t, text) => {
      rec('tracker.onTurnEnd', [t, text]);
      if (opts.gate) await opts.gate;
      const b = opts.finalBelief ? opts.finalBelief(t) : belief('unknown');
      if (opts.emitFinal) orch.onTrackerEvent({ type: 'belief_update', turnId: t, belief: b });
      return b;
    },
  };
  const orch: Orchestrator = new Orchestrator({
    send: (ev) => void ws.push(ev),
    voice: {
      handleClient: (ev) => void rec('voice.handleClient', [ev.type]),
      handleInterject: (t, text) => void rec('voice.handleInterject', [t, text]),
      close: () => void rec('voice.close', []),
    },
    tracker: opts.tracker === false ? null : tracker,
    speculator: {
      onServerEvent: (ev) => void specEvents.push(ev),
      onConfirm: (t, apply) => {
        rec('spec.onConfirm', [t, apply]);
        if (opts.autoState) orch.onSpeculatorEvent(sc(t, apply ? 'COMMITTED' : 'ROLLED_BACK'));
      },
    },
    speaker: {
      speak: (text, o) => {
        spoken.push({ text, opts: o });
        return `ctx-${spoken.length}`;
      },
      cancelActive: () => null,
    },
    answerer: { answer: opts.answer ?? (async () => 'Your meeting is at two.') },
    demo: opts.demo
      ? { start: (f) => void rec('demo.start', [f]), stop: () => void rec('demo.stop', []) }
      : null,
    today: () => new Date(2026, 9, 24), // Saturday
    correctionTimeoutMs: opts.correctionTimeoutMs ?? 10_000,
    confirmWindowMs: opts.confirmWindowMs ?? 10_000,
    memory: opts.memory ? { add: async (d) => void mem.push(d) } : null,
    retrieval: opts.retrieval ?? null,
    upcoming: opts.upcoming ?? null,
  });
  const names = () => calls.map((c) => c.name);
  const specTypes = () => specEvents.map((e) => `${e.type}:${'turnId' in e ? e.turnId : ''}`);
  const texts = () => spoken.map((s) => s.text);
  /** Latest written version of each memory doc, by id. */
  const memDocs = () => new Map(mem.map((d) => [d.id, d]));
  return { orch, calls, ws, specEvents, spoken, mem, memDocs, names, specTypes, texts };
}

type S = ReturnType<typeof setup>;
const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 5; i++) await tick();
}
const start = (t: string): ServerEvent => ({ type: 'turn_start', turnId: t, ts: 1 });
const partial = (t: string, text: string): ServerEvent => ({ type: 'transcript_partial', turnId: t, text, ts: 1 });
const eager = (t: string, text: string): ServerEvent => ({ type: 'turn_eager_end', turnId: t, text, ts: 1 });
const resume = (t: string): ServerEvent => ({ type: 'turn_resume', turnId: t, ts: 1 });
const final = (t: string, text: string): ServerEvent => ({ type: 'transcript_final', turnId: t, text, ts: 1 });
const end = (t: string): ServerEvent => ({ type: 'turn_end', turnId: t, ts: 1 });
const bu = (t: string, b: Belief): ServerEvent => ({ type: 'belief_update', turnId: t, belief: b });
const sc = (t: string, state: State): ServerEvent => ({ type: 'state_change', turnId: t, state });

/** A full voice turn the way VoiceSession emits it, ending with the onTurnEnd hook. */
function utter(s: S, t: string, text: string) {
  s.orch.onVoiceEvent(start(t));
  s.orch.onVoiceEvent(partial(t, text));
  s.orch.onVoiceEvent(final(t, text));
  s.orch.onVoiceEvent(end(t));
  if (text.trim() !== '') s.orch.onVoiceTurnEnd(t, text.trim());
}

/** A turn that has started and shown real speech (a bare turn_start may be an Ink phantom). */
function begin(s: S, t: string, text = 'Draft a message to Priya') {
  s.orch.onVoiceEvent(start(t));
  s.orch.onVoiceEvent(partial(t, text));
}

/** Turn t1 speculates a draft to Priya and is STAGED after its turn end. */
async function stagedTurn(s: S) {
  begin(s, 't1');
  s.orch.onSpeculatorEvent(sc('t1', 'LISTENING'));
  s.orch.onTrackerEvent(bu('t1', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('t1', 'SPECULATING'));
  s.orch.onVoiceEvent(final('t1', 'Draft a message to Priya'));
  s.orch.onVoiceEvent(end('t1'));
  s.orch.onVoiceTurnEnd('t1', 'Draft a message to Priya');
  await settle();
  s.orch.onSpeculatorEvent(sc('t1', 'STAGED'));
}

test('routes partial, eager_end, resume, turn_end to tracker and speculator per the table', async () => {
  const s = setup();
  s.orch.onVoiceEvent(start('t1'));
  s.orch.onVoiceEvent(partial('t1', 'move my'));
  s.orch.onVoiceEvent(eager('t1', 'move my meeting'));
  await settle(); // the eager end reaches the speculator once the tracker's belief landed
  s.orch.onVoiceEvent(resume('t1'));
  s.orch.onVoiceEvent(final('t1', 'move my meeting'));
  s.orch.onVoiceEvent(end('t1'));
  await settle();
  assert.deepEqual(s.names(), ['tracker.onUpdate', 'tracker.onEagerEnd', 'tracker.onResume']);
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'turn_eager_end:t1', 'turn_resume:t1', 'turn_end:t1']);
  assert.deepEqual(
    s.ws.map((e) => e.type),
    ['turn_start', 'transcript_partial', 'turn_eager_end', 'turn_resume', 'transcript_final', 'turn_end'],
  );
});

test('belief_update and moss_hits from the tracker reach ws and speculator', () => {
  const s = setup();
  begin(s, 't1');
  s.orch.onTrackerEvent(bu('t1', belief('lookup')));
  s.orch.onTrackerEvent({ type: 'moss_hits', turnId: 't1', query: 'q', hits: [], latencyMs: 2 });
  s.orch.onTrackerEvent({ type: 'metric', source: 'moss', label: 'query', ms: 2 });
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'belief_update:t1', 'moss_hits:t1']);
  assert.deepEqual(s.ws.map((e) => e.type), ['turn_start', 'transcript_partial', 'belief_update', 'moss_hits', 'metric']);
});

test('tracker interject calls voice.handleInterject and is not sent to ws directly', () => {
  const s = setup();
  begin(s, 't1');
  s.orch.onTrackerEvent({ type: 'interject', turnId: 't1', text: 'Say Friday?' });
  assert.deepEqual(s.calls.find((c) => c.name === 'voice.handleInterject')?.args, ['t1', 'Say Friday?']);
  assert.equal(s.ws.filter((e) => e.type === 'interject').length, 0);
  // VoiceSession.handleInterject sends it through its own `send`: forwarded exactly once.
  s.orch.onVoiceEvent({ type: 'interject', turnId: 't1', text: 'Say Friday?' });
  assert.equal(s.ws.filter((e) => e.type === 'interject').length, 1);
});

test('repeated turn_start emits one synthetic turn_end for the old turn to ws, speculator and tracker', async () => {
  const s = setup();
  s.orch.onVoiceEvent(start('t1'));
  s.orch.onVoiceEvent(partial('t1', 'move my meeting'));
  s.orch.onVoiceEvent(start('t2'));
  await settle();
  // t2's turn_start reaches the speculator only once it shows speech (it may be an Ink phantom).
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'turn_end:t1']);
  s.orch.onVoiceEvent(partial('t2', 'and'));
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'turn_end:t1', 'turn_start:t2']);
  assert.deepEqual(
    s.ws.map((e) => `${e.type}:${'turnId' in e ? e.turnId : ''}`),
    ['turn_start:t1', 'transcript_partial:t1', 'turn_end:t1', 'turn_start:t2', 'transcript_partial:t2'],
  );
  const ends = s.calls.filter((c) => c.name === 'tracker.onTurnEnd');
  assert.deepEqual(ends.map((c) => c.args), [['t1', 'move my meeting']]);
  assert.equal(s.spoken.length, 0);
});

test("lookup final belief speaks the answerer's answer", async () => {
  let asked: [string, MossHit[]] | null = null;
  const s = setup({
    finalBelief: () => belief('lookup'),
    answer: async (q, hits) => {
      asked = [q, hits];
      return 'Your meeting is at two.';
    },
  });
  utter(s, 't1', 'When is my meeting?');
  await settle();
  assert.deepEqual(asked, ['When is my meeting?', belief('lookup').topHits]);
  assert.deepEqual(s.spoken, [{ text: 'Your meeting is at two.', opts: { interrupt: false, turnId: 't1' } }]);
});

test('lookup puts upcoming calendar hits first, without duplicates, and passes today', async () => {
  let asked: { hits: string[]; today?: Date } | null = null;
  let upcomingFor: [string, string] | null = null;
  const s = setup({
    finalBelief: () => ({ ...belief('lookup'), topHits: [{ docId: 'past', score: 0.9, snippet: 'Oct 5' }, { docId: 'next', score: 0.5, snippet: 'Oct 26' }] }),
    upcoming: async (text, todayIso) => {
      upcomingFor = [text, todayIso];
      return [{ docId: 'next', score: 0.4, snippet: 'Oct 26' }];
    },
    answer: async (_q, hits, today) => {
      asked = { hits: hits.map((h) => h.docId), today };
      return 'Monday at 11:59 PM.';
    },
  });
  utter(s, 't1', 'When is my homework due?');
  await settle();
  assert.deepEqual(upcomingFor, ['When is my homework due?', '2026-10-24']);
  assert.deepEqual(asked!.hits, ['next', 'past']);
  assert.equal(asked!.today?.getDate(), 24);
});

test('answerer rejecting speaks the fallback and sends an llm error', async () => {
  const s = setup({ finalBelief: () => belief('lookup'), answer: async () => Promise.reject(new Error('529')) });
  utter(s, 't1', 'When is my meeting?');
  await settle();
  assert.deepEqual(s.texts(), [FALLBACK_REPLY]);
  assert.ok(s.ws.some((e) => e.type === 'error' && e.source === 'llm'));
});

test('empty answer speaks the fallback', async () => {
  const s = setup({ finalBelief: () => belief('lookup'), answer: async () => '  ' });
  utter(s, 't1', 'When is my meeting?');
  await settle();
  assert.deepEqual(s.texts(), [FALLBACK_REPLY]);
});

test('speculative intent while SPECULATING speaks nothing at turn end; STAGED later speaks "Apply?"', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  begin(s, 't1');
  s.orch.onTrackerEvent(bu('t1', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('t1', 'SPECULATING'));
  s.orch.onVoiceEvent(final('t1', 'Draft a message to Priya'));
  s.orch.onVoiceEvent(end('t1'));
  s.orch.onVoiceTurnEnd('t1', 'Draft a message to Priya');
  await settle();
  assert.equal(s.spoken.length, 0);
  s.orch.onSpeculatorEvent(sc('t1', 'STAGED'));
  assert.deepEqual(s.spoken, [
    { text: 'Apply?', opts: { interrupt: false, turnId: 't1' } },
  ]);
  assert.ok(s.ws.some((e) => e.type === 'state_change' && e.state === 'STAGED'));
});

test('STAGED before turn end speaks at turn end', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  begin(s, 't1');
  s.orch.onTrackerEvent(bu('t1', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('t1', 'SPECULATING'));
  s.orch.onSpeculatorEvent(sc('t1', 'STAGED'));
  assert.equal(s.spoken.length, 0);
  s.orch.onVoiceEvent(end('t1'));
  s.orch.onVoiceTurnEnd('t1', 'Draft a message to Priya');
  await settle();
  assert.deepEqual(s.texts(), ['Apply?']);
});

test('unknown intent speaks the fallback', async () => {
  const s = setup({ finalBelief: () => belief('unknown') });
  utter(s, 't1', 'Blah blah');
  await settle();
  assert.deepEqual(s.spoken, [{ text: FALLBACK_REPLY, opts: { interrupt: false, turnId: 't1' } }]);
});

test('empty final speaks nothing', async () => {
  const s = setup();
  utter(s, 't1', '');
  await settle();
  assert.equal(s.spoken.length, 0);
});

test('onVoiceTurnEnd never throws when the tracker rejects', async () => {
  const s = setup({
    finalBelief: () => {
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => utter(s, 't1', 'hello'));
  await settle();
  assert.ok(s.ws.some((e) => e.type === 'error'));
});

test('spoken "Yes." after STAGED calls onConfirm(stagedTurn, true), never forwards the yes turn to the speculator, and speaks "Done." on COMMITTED', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true });
  await stagedTurn(s);
  const before = s.specEvents.length;
  utter(s, 't2', 'Yes.');
  await settle();
  assert.deepEqual(s.calls.filter((c) => c.name === 'spec.onConfirm').map((c) => c.args), [['t1', true]]);
  assert.equal(s.specEvents.length, before, 'yes turn not forwarded');
  assert.deepEqual(s.texts(), ['Apply?', APPLIED_REPLY]);
  assert.ok(s.calls.some((c) => c.name === 'tracker.onTurnEnd' && c.args[0] === 't2'));
});

test('spoken "No." after STAGED calls onConfirm(stagedTurn, false) and speaks "Dropped." on ROLLED_BACK', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true });
  await stagedTurn(s);
  const before = s.specEvents.length;
  utter(s, 't2', 'No.');
  await settle();
  assert.deepEqual(s.calls.filter((c) => c.name === 'spec.onConfirm').map((c) => c.args), [['t1', false]]);
  assert.equal(s.specEvents.length, before);
  assert.deepEqual(s.texts(), ['Apply?', DISCARDED_REPLY]);
});

test('non-confirm first partial after STAGED releases: the turn reaches the speculator in order', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  await stagedTurn(s);
  const before = s.specEvents.length;
  s.orch.onVoiceEvent(start('t2'));
  assert.equal(s.specEvents.length, before, 'held until its first text');
  s.orch.onVoiceEvent(partial('t2', 'Okay so move my meeting'));
  s.orch.onTrackerEvent(bu('t2', belief('unknown')));
  s.orch.onVoiceEvent(eager('t2', 'Okay so move my meeting'));
  await settle(); // the eager end reaches the speculator once the tracker's belief landed
  assert.deepEqual(s.specTypes().slice(before), ['turn_start:t2', 'belief_update:t2', 'turn_eager_end:t2']);
  assert.equal(s.calls.filter((c) => c.name === 'spec.onConfirm').length, 0);
});

test('client confirm_action calls onConfirm', () => {
  const s = setup();
  s.orch.onClient({ type: 'confirm_action', turnId: 't1', apply: true });
  assert.deepEqual(s.calls.find((c) => c.name === 'spec.onConfirm')?.args, ['t1', true]);
});

test('demo_control start calls demo.start with the fixture', () => {
  const s = setup({ demo: true });
  s.orch.onClient({ type: 'demo_control', action: 'start', fixture: 'demo-utterance-2' });
  s.orch.onClient({ type: 'demo_control', action: 'start' });
  s.orch.onClient({ type: 'demo_control', action: 'stop' });
  assert.deepEqual(
    s.calls.map((c) => [c.name, ...c.args]),
    [['demo.start', 'demo-utterance-2'], ['demo.start', 'demo-real-1'], ['demo.stop']],
  );
  s.orch.onClient({ type: 'demo_control', action: 'reset' });
  assert.ok(s.ws.some((e) => e.type === 'error' && e.source === 'demo'));
});

test('demo_control without a demo sends a demo error', () => {
  const s = setup();
  s.orch.onClient({ type: 'demo_control', action: 'start' });
  assert.ok(s.ws.some((e) => e.type === 'error' && e.source === 'demo'));
});

test('audio_chunk ignored when demo is set', () => {
  const chunk: ClientEvent = { type: 'audio_chunk', pcm: '', sampleRate: 16000, seq: 1 };
  const demo = setup({ demo: true });
  demo.orch.onClient(chunk);
  assert.equal(demo.calls.length, 0);
  const live = setup();
  live.orch.onClient(chunk);
  assert.deepEqual(live.names(), ['voice.handleClient']);
});

test('close() while STAGED calls onConfirm(turn, false) and voice.close()', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), demo: true });
  await stagedTurn(s);
  s.orch.close();
  assert.ok(s.names().includes('voice.close'));
  assert.ok(s.names().includes('demo.stop'));
  assert.deepEqual(s.calls.filter((c) => c.name === 'spec.onConfirm').map((c) => c.args), [['t1', false]]);
});

test('close() while idle does not call onConfirm', () => {
  const s = setup();
  begin(s, 't1');
  s.orch.onSpeculatorEvent(sc('t1', 'LISTENING'));
  s.orch.close();
  assert.ok(s.names().includes('voice.close'));
  assert.ok(!s.names().includes('spec.onConfirm'));
});

// ---- interject correction ----

const draft = (day: string, claims: Claim[] = [DAY_CLAIM]) =>
  belief('draft_message', { person: 'Priya Shah', day }, claims);

/** Turn t1 with an interject after the claim-carrying belief_update; ends the turn. */
async function interjectedTurn(s: S) {
  begin(s, 't1');
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  s.orch.onTrackerEvent({ type: 'interject', turnId: 't1', text: INTERJECT });
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  s.orch.onVoiceEvent(eager('t1', "Draft a message to Priya saying I'll see her Thursday"));
  await settle(); // the eager end reaches the speculator once the tracker's belief landed
  s.orch.onVoiceEvent(final('t1', "Draft a message to Priya saying I'll see her Thursday"));
  s.orch.onVoiceEvent(end('t1'));
  s.orch.onVoiceTurnEnd('t1', "Draft a message to Priya saying I'll see her Thursday");
  await settle();
}
const correctionOpts: Opts = { finalBelief: () => draft('thursday'), emitFinal: true };

test('after an interject, eager_end/turn_end/final belief are not sent to the speculator until the correction resolves', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'belief_update:t1']);
  assert.equal(s.spoken.length, 0, 'nothing spoken at the interjected turn end');
  // The next turn is held too.
  s.orch.onVoiceEvent(start('t2'));
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'belief_update:t1']);
});

test('spoken "Yes." after an interject flushes the deferred events with day friday in every belief_update, speaks "Friday.", and does not call onConfirm', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  utter(s, 't2', 'Yes.');
  await settle();
  const flushed = s.specEvents.slice(2);
  assert.deepEqual(
    flushed.map((e) => `${e.type}:${'turnId' in e ? e.turnId : ''}`),
    ['belief_update:t1', 'turn_eager_end:t1', 'turn_end:t1', 'belief_update:t1'],
  );
  for (const e of flushed) if (e.type === 'belief_update') assert.equal(e.belief.entities.day, 'friday');
  assert.deepEqual(s.texts(), ['Friday.']);
  assert.equal(s.calls.filter((c) => c.name === 'spec.onConfirm').length, 0);
  // Later belief_updates of t1 are corrected too, and STAGED asks with the corrected belief.
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  const last = s.specEvents.at(-1);
  assert.ok(last?.type === 'belief_update' && last.belief.entities.day === 'friday');
  s.orch.onSpeculatorEvent(sc('t1', 'STAGED'));
  assert.deepEqual(s.texts(), ['Friday.', 'Apply?']);
});

test('spoken "No." after an interject flushes unchanged beliefs and speaks "Thursday."', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  utter(s, 't2', 'No.');
  await settle();
  const flushed = s.specEvents.slice(2);
  assert.equal(flushed.length, 4);
  for (const e of flushed) if (e.type === 'belief_update') assert.equal(e.belief.entities.day, 'thursday');
  assert.deepEqual(s.texts(), ['Thursday.']);
  assert.equal(s.calls.filter((c) => c.name === 'spec.onConfirm').length, 0);
});

test('confirm_action apply:true for the interjected turn applies the correction (not a commit)', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  s.orch.onClient({ type: 'confirm_action', turnId: 't1', apply: true });
  const flushed = s.specEvents.slice(2);
  assert.equal(flushed.length, 4);
  for (const e of flushed) if (e.type === 'belief_update') assert.equal(e.belief.entities.day, 'friday');
  assert.equal(s.calls.filter((c) => c.name === 'spec.onConfirm').length, 0);
  assert.equal(s.spoken.length, 0);
});

test('no answer within correctionTimeoutMs flushes unchanged', async () => {
  const s = setup({ ...correctionOpts, correctionTimeoutMs: 20 });
  await interjectedTurn(s);
  assert.equal(s.specEvents.length, 2);
  await new Promise((r) => setTimeout(r, 60));
  const flushed = s.specEvents.slice(2);
  assert.equal(flushed.length, 4);
  for (const e of flushed) if (e.type === 'belief_update') assert.equal(e.belief.entities.day, 'thursday');
  assert.equal(s.spoken.length, 0);
});

test('non-confirm utterance after an interject flushes the correction unchanged, then the new turn', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  s.orch.onVoiceEvent(start('t2'));
  s.orch.onVoiceEvent(partial('t2', 'Actually move my meeting'));
  assert.deepEqual(s.specTypes().slice(2), [
    'belief_update:t1',
    'turn_eager_end:t1',
    'turn_end:t1',
    'belief_update:t1',
    'turn_start:t2',
  ]);
  assert.equal(s.spoken.length, 0);
});

// ---- superseded turns ----

test('a turn superseded while its final belief is in flight does not ask "Apply?" (STAGED before turn end)', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), gate });
  begin(s, 'A');
  s.orch.onSpeculatorEvent(sc('A', 'LISTENING'));
  s.orch.onTrackerEvent(bu('A', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('A', 'SPECULATING'));
  s.orch.onSpeculatorEvent(sc('A', 'STAGED'));
  s.orch.onVoiceEvent(end('A'));
  s.orch.onVoiceTurnEnd('A', 'Text Priya');
  // B starts while A's final belief is pending: forwarded, so the speculator rolls A back silently.
  s.orch.onVoiceEvent(start('B'));
  s.orch.onVoiceEvent(partial('B', 'Add milk'));
  assert.ok(s.specTypes().includes('turn_start:B'));
  s.orch.onSpeculatorEvent(sc('B', 'LISTENING'));
  open();
  await settle();
  assert.equal(s.spoken.length, 0);
  // Nothing awaits a confirm: the next turn is not held.
  s.orch.onVoiceEvent(partial('B', 'Yes'));
  s.orch.onVoiceEvent(end('B'));
  assert.ok(s.specTypes().includes('turn_end:B'));
});

test('a superseded SPECULATING turn speaks nothing, and a stale STAGED for it is ignored', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), gate });
  begin(s, 'A');
  s.orch.onSpeculatorEvent(sc('A', 'LISTENING'));
  s.orch.onTrackerEvent(bu('A', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('A', 'SPECULATING'));
  s.orch.onVoiceEvent(end('A'));
  s.orch.onVoiceTurnEnd('A', 'Text Priya');
  begin(s, 'B', 'Add milk');
  open();
  await settle();
  s.orch.onSpeculatorEvent(sc('A', 'STAGED'));
  assert.equal(s.spoken.length, 0);
});

test('an interjected turn that ends with an empty final flushes unchanged, and a later interject defers again', async () => {
  const s = setup(correctionOpts);
  begin(s, 't1');
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  s.orch.onTrackerEvent({ type: 'interject', turnId: 't1', text: INTERJECT });
  s.orch.onVoiceEvent(eager('t1', ''));
  await settle(); // the eager end reaches the speculator once the tracker's belief landed
  s.orch.onVoiceEvent(final('t1', ''));
  s.orch.onVoiceEvent(end('t1')); // VoiceSession does not call onTurnEnd for an empty final
  await settle();
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'belief_update:t1', 'turn_eager_end:t1', 'turn_end:t1']);
  assert.equal(s.specEvents.filter((e) => e.type === 'belief_update' && e.belief.entities.day === 'friday').length, 0);
  assert.equal(s.spoken.length, 0);
  begin(s, 't2');
  s.orch.onTrackerEvent(bu('t2', draft('thursday')));
  s.orch.onTrackerEvent({ type: 'interject', turnId: 't2', text: INTERJECT });
  s.orch.onVoiceEvent(eager('t2', 'x'));
  await settle(); // the eager end reaches the speculator once the tracker's belief landed
  assert.equal(s.specTypes().at(-1), 'belief_update:t2', 'eager_end of t2 deferred');
});

// ---- phantom turns and HUD ----

test('a phantom turn_start (then empty turn_end) during SPECULATING never reaches the speculator; the turn still stages and asks', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  begin(s, 'A');
  s.orch.onTrackerEvent(bu('A', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('A', 'SPECULATING'));
  s.orch.onVoiceEvent(final('A', 'Draft a message to Priya'));
  s.orch.onVoiceEvent(end('A'));
  s.orch.onVoiceTurnEnd('A', 'Draft a message to Priya');
  await settle();
  s.orch.onVoiceEvent(start('P'));
  s.orch.onVoiceEvent(final('P', ''));
  s.orch.onVoiceEvent(end('P'));
  await settle();
  assert.ok(!s.specTypes().some((t) => t.endsWith(':P')), s.specTypes().join(','));
  assert.ok(s.ws.some((e) => e.type === 'turn_start' && e.turnId === 'P'), 'ws still sees the phantom');
  s.orch.onSpeculatorEvent(sc('A', 'STAGED'));
  assert.deepEqual(s.texts(), ['Apply?']);
});

test('a phantom that supersedes an open turn: synthetic end reaches the speculator, the old turn stages and asks', async () => {
  const s = setup();
  begin(s, 'A');
  s.orch.onTrackerEvent(bu('A', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('A', 'SPECULATING'));
  s.orch.onVoiceEvent(start('P'));
  s.orch.onVoiceEvent(end('P'));
  s.orch.onVoiceEvent(start('Q')); // synthetic end for a never-forwarded turn is dropped too
  await settle();
  assert.deepEqual(s.specTypes(), ['turn_start:A', 'belief_update:A', 'turn_end:A']);
  s.orch.onSpeculatorEvent(sc('A', 'STAGED'));
  assert.deepEqual(s.texts(), ['Apply?']);
});

test('a confirm whose only text arrives in transcript_final ("Yes.") still confirms', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true });
  await stagedTurn(s);
  const before = s.specEvents.length;
  s.orch.onVoiceEvent(start('t2'));
  s.orch.onVoiceEvent(final('t2', 'Yes.'));
  s.orch.onVoiceEvent(end('t2'));
  s.orch.onVoiceTurnEnd('t2', 'Yes.');
  await settle();
  assert.deepEqual(s.calls.filter((c) => c.name === 'spec.onConfirm').map((c) => c.args), [['t1', true]]);
  assert.equal(s.specEvents.length, before);
  assert.deepEqual(s.texts(), ['Apply?', APPLIED_REPLY]);
});

test('mock belief: voice belief_update and interject still start the correction deferral', () => {
  const s = setup({ tracker: false });
  begin(s, 't1');
  s.orch.onVoiceEvent(bu('t1', draft('thursday')));
  s.orch.onVoiceEvent({ type: 'interject', turnId: 't1', text: INTERJECT });
  s.orch.onVoiceEvent(eager('t1', 'Draft a message to Priya'));
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'belief_update:t1']);
});

test('after a correction yes the HUD receives the corrected belief, and later beliefs of the turn too', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  const before = s.ws.length;
  utter(s, 't2', 'Yes.');
  await settle();
  const hud = s.ws.slice(before).filter((e) => e.type === 'belief_update' && e.turnId === 't1');
  assert.ok(hud.length >= 1);
  for (const e of hud) assert.ok(e.type === 'belief_update' && e.belief.entities.day === 'friday');
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  const last = s.ws.at(-1);
  assert.ok(last?.type === 'belief_update' && last.belief.entities.day === 'friday');
});

// ---- fast confirm and the confirm window ----

const confirms = (s: S) => s.calls.filter((c) => c.name === 'spec.onConfirm').map((c) => c.args);
const windowMetrics = (s: S) =>
  s.ws.flatMap((e) => (e.type === 'metric' && e.label.startsWith('confirm_window') ? [e.ms] : []));
const windowLabels = (s: S) =>
  s.ws.flatMap((e) => (e.type === 'metric' && e.label.startsWith('confirm_window') ? [e.label] : []));

test('"Yeah, do it" as the first partial after STAGED confirms at once, before any turn end', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true });
  await stagedTurn(s);
  const before = s.specEvents.length;
  s.orch.onVoiceEvent(start('t2'));
  s.orch.onVoiceEvent(partial('t2', 'Yeah, do it'));
  assert.deepEqual(confirms(s), [['t1', true]]);
  assert.deepEqual(s.texts(), ['Apply?', APPLIED_REPLY]);
  // The rest of the turn never speculates and does not ask again.
  s.orch.onVoiceEvent(partial('t2', 'Yeah, do it now'));
  s.orch.onVoiceEvent(final('t2', 'Yeah, do it now'));
  s.orch.onVoiceEvent(end('t2'));
  s.orch.onVoiceTurnEnd('t2', 'Yeah, do it now');
  await settle();
  assert.equal(s.specEvents.length, before);
  assert.deepEqual(confirms(s), [['t1', true]]);
  assert.deepEqual(s.texts(), ['Apply?', APPLIED_REPLY]);
});

test('"Drop it" as the first partial after STAGED rejects at once', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true });
  await stagedTurn(s);
  s.orch.onVoiceEvent(start('t2'));
  s.orch.onVoiceEvent(partial('t2', 'Drop it.'));
  assert.deepEqual(confirms(s), [['t1', false]]);
  assert.deepEqual(s.texts(), ['Apply?', DISCARDED_REPLY]);
});

test('a yes partial applies the correction at once and does not wait for turn end', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  s.orch.onVoiceEvent(start('t2'));
  s.orch.onVoiceEvent(partial('t2', 'Yep'));
  assert.deepEqual(s.texts(), ['Friday.']);
  const flushed = s.specEvents.slice(2);
  assert.equal(flushed.length, 4);
  for (const e of flushed) if (e.type === 'belief_update') assert.equal(e.belief.entities.day, 'friday');
});

test('a phantom turn_start that arrived before STAGED still carries the spoken yes, and never reaches the speculator', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true });
  begin(s, 't1');
  s.orch.onTrackerEvent(bu('t1', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('t1', 'SPECULATING'));
  s.orch.onVoiceEvent(end('t1'));
  s.orch.onVoiceTurnEnd('t1', 'Draft a message to Priya');
  await settle();
  s.orch.onVoiceEvent(start('p')); // Ink phantom right after the turn end
  s.orch.onSpeculatorEvent(sc('t1', 'STAGED'));
  const before = s.specEvents.length;
  s.orch.onVoiceEvent(partial('p', 'Yes'));
  assert.deepEqual(confirms(s), [['t1', true]]);
  assert.equal(s.specEvents.length, before);
});

test('the HUD gets a confirm_window metric: 6 s for Apply?, 4 s for a correction, 0 when it closes', async () => {
  const a = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true, confirmWindowMs: 6000 });
  await stagedTurn(a);
  assert.deepEqual(windowMetrics(a), [6000]);
  a.orch.onVoiceEvent(start('t2'));
  a.orch.onVoiceEvent(partial('t2', 'Yes'));
  assert.deepEqual(windowMetrics(a), [6000, 0]);

  const c = setup({ ...correctionOpts, correctionTimeoutMs: 4000 });
  await interjectedTurn(c);
  assert.deepEqual(windowMetrics(c), [4000]);
  c.orch.onVoiceEvent(start('t2'));
  c.orch.onVoiceEvent(partial('t2', 'No'));
  assert.deepEqual(windowMetrics(c), [4000, 0]);
  a.orch.close();
  c.orch.close();
});

test('an unanswered Apply? closes after confirmWindowMs; a later "yes" is a no-op and rolls nothing back', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), confirmWindowMs: 20 });
  await stagedTurn(s);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(windowMetrics(s), [20, 0]);
  const before = s.specEvents.length;
  const spokenBefore = s.texts().length;
  utter(s, 't2', 'Yes.');
  await settle();
  assert.deepEqual(confirms(s), []);
  assert.equal(s.specEvents.length, before, 'no turn_start, so the staged draft survives');
  assert.equal(s.texts().length, spokenBefore, 'no fallback reply');
});

test('a bare "No." with nothing pending is a no-op', async () => {
  const s = setup();
  utter(s, 't1', 'No.');
  await settle();
  assert.deepEqual(s.specEvents, []);
  assert.deepEqual(s.texts(), []);
});

test('"Yes, draft a message to Marcus" with nothing pending starts the turn once it is more than a yes', () => {
  const s = setup();
  s.orch.onVoiceEvent(start('t1'));
  s.orch.onVoiceEvent(partial('t1', 'Yes'));
  assert.deepEqual(s.specTypes(), []);
  s.orch.onVoiceEvent(partial('t1', 'Yes, draft a message to Marcus'));
  assert.deepEqual(s.specTypes(), ['turn_start:t1']);
});

test('first answer wins: a click Discard right after a spoken correction yes is ignored', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  s.orch.onVoiceEvent(start('t2'));
  s.orch.onVoiceEvent(partial('t2', 'Yes'));
  s.orch.onClient({ type: 'confirm_action', turnId: 't1', apply: false });
  assert.deepEqual(confirms(s), []);
  assert.deepEqual(s.texts(), ['Friday.']);
});

test('first answer wins: a spoken yes after a click Apply is a no-op', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true });
  await stagedTurn(s);
  s.orch.onClient({ type: 'confirm_action', turnId: 't1', apply: true });
  const before = s.specEvents.length;
  utter(s, 't2', 'Yes.');
  await settle();
  assert.deepEqual(confirms(s), [['t1', true]]);
  assert.equal(s.specEvents.length, before);
});

test('the window label names the pending kind and turn', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  await stagedTurn(s);
  assert.deepEqual(windowLabels(s), ['confirm_window:apply:t1']);
  s.orch.onClient({ type: 'confirm_action', turnId: 't1', apply: true });
  assert.deepEqual(windowLabels(s), ['confirm_window:apply:t1', 'confirm_window']);
  s.orch.close();
});

test('default windows: correction 4000 ms, Apply? 6000 ms', () => {
  assert.equal(CORRECTION_TIMEOUT_MS, 4000);
  assert.equal(CONFIRM_WINDOW_MS, 6000);
});

// ---- eager end waits for the tracker ----

test('eager end reaches the speculator after the belief the tracker made from the eager text', async () => {
  let open!: () => void;
  const s = setup({ eagerGate: new Promise<void>((r) => (open = r)) });
  begin(s, 't1', 'Move my Friday meeting with Priya to Monday');
  s.orch.onVoiceEvent(eager('t1', 'Move my Friday meeting with Priya to Monday morning.'));
  await settle();
  assert.deepEqual(s.specTypes(), ['turn_start:t1'], 'eager end held while the tracker works');
  s.orch.onTrackerEvent(bu('t1', belief('reschedule_event', { time: '09:00' })));
  open();
  await settle();
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'belief_update:t1', 'turn_eager_end:t1']);
});

test('a turn_resume before the tracker finishes drops the delayed eager end', async () => {
  let open!: () => void;
  const s = setup({ eagerGate: new Promise<void>((r) => (open = r)) });
  begin(s, 't1');
  s.orch.onVoiceEvent(eager('t1', 'Draft a message to Priya'));
  s.orch.onVoiceEvent(resume('t1'));
  open();
  await settle();
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'turn_resume:t1']);
});

// ---- conversation memory ----

const PRIYA_DIFF = '--- /dev/null\n+++ b/messages/outbox/priya.md\n@@ -0,0 +1,3 @@\n+To: Priya Shah <priya.shah@example.com>\n+\n+Hi Priya, see you Friday.';
const diffEv = (t: string, file: string, diff: string): ServerEvent => ({ type: 'droid_event', turnId: t, kind: 'diff', payload: { file, diff }, ts: 1 });

test('memory: a staged turn is written at turn end, then upserted with its outcome and the committed draft', async () => {
  const s = setup({ memory: true, autoState: true, finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  await stagedTurn(s);
  assert.equal(s.memDocs().get('memory-t1')?.metadata.outcome, 'staged');
  assert.match(s.memDocs().get('memory-t1')!.text, /^User said: "Draft a message to Priya" Understood: draft_message person=Priya Shah\. Outcome: staged\.$/);
  s.orch.onSpeculatorEvent(diffEv('t1', 'messages/outbox/priya.md', 'stale'));
  s.orch.onSpeculatorEvent(diffEv('t1', 'messages/outbox/priya.md', PRIYA_DIFF));
  s.orch.onClient({ type: 'confirm_action', turnId: 't1', apply: true });
  const docs = s.memDocs();
  assert.equal(docs.get('memory-t1')?.metadata.outcome, 'committed');
  assert.equal(
    docs.get('memory-t1-artifact')?.text,
    'Told Priya Shah in a message on 2026-10-24. messages/outbox/priya.md: To: Priya Shah <priya.shah@example.com> Hi Priya, see you Friday.',
  );
});

test('memory: a rolled-back turn is upserted as rolled back and stores no artifact', async () => {
  const s = setup({ memory: true, autoState: true, finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  await stagedTurn(s);
  s.orch.onSpeculatorEvent(diffEv('t1', 'messages/outbox/priya.md', PRIYA_DIFF));
  s.orch.onClient({ type: 'confirm_action', turnId: 't1', apply: false });
  assert.equal(s.memDocs().get('memory-t1')?.metadata.outcome, 'rolled back');
  assert.equal(s.memDocs().has('memory-t1-artifact'), false);
});

test('memory: a lookup is remembered as a lookup, and its dropped speculation does not change that', async () => {
  const s = setup({ memory: true, finalBelief: () => belief('lookup', { person: 'Priya' }) });
  begin(s, 't1', 'What did I tell Priya?');
  s.orch.onSpeculatorEvent(sc('t1', 'SPECULATING'));
  s.orch.onVoiceEvent(end('t1'));
  s.orch.onVoiceTurnEnd('t1', 'What did I tell Priya?');
  await settle();
  s.orch.onSpeculatorEvent(sc('t1', 'ROLLED_BACK'));
  assert.equal(s.mem.length, 1);
  assert.equal(s.mem[0]!.metadata.outcome, 'lookup');
  assert.equal(s.mem[0]!.metadata.people, 'Priya');
});

test('memory: a bare yes/no and a spoken confirm write nothing of their own', async () => {
  const s = setup({ memory: true, autoState: true, finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  utter(s, 't0', 'Yes.');
  await settle();
  assert.equal(s.mem.length, 0);
  await stagedTurn(s);
  utter(s, 't2', 'Yes.');
  await settle();
  assert.deepEqual([...s.memDocs().keys()], ['memory-t1']);
  assert.equal(s.memDocs().get('memory-t1')?.metadata.outcome, 'committed');
});

test('memory: an unknown request is remembered as no action; nothing is written without a memory port', async () => {
  const s = setup({ memory: true });
  utter(s, 't1', 'What is the weather');
  await settle();
  assert.equal(s.mem[0]?.metadata.outcome, 'no action');
  const quiet = setup();
  utter(quiet, 't1', 'What is the weather');
  await settle();
  assert.equal(quiet.mem.length, 0);
});

// ---- retrieval A/B ----

const metricsOf = (s: S, prefix: string) =>
  s.ws.flatMap((e) => (e.type === 'metric' && e.label.startsWith(prefix) ? [`${e.label}=${e.ms}`] : []));

test('retrieval_mode switches the retriever and confirms with a retrieval:<mode> metric', () => {
  const retrieval = { mode: 'moss' as RetrievalMode, delayMs: 300 };
  const s = setup({ retrieval });
  s.orch.onClient({ type: 'retrieval_mode', mode: 'cloud-sim' });
  assert.equal(retrieval.mode, 'cloud-sim');
  s.orch.onClient({ type: 'retrieval_mode', mode: 'moss' });
  assert.equal(retrieval.mode, 'moss');
  assert.deepEqual(metricsOf(s, 'retrieval:'), ['retrieval:cloud-sim=300', 'retrieval:moss=0']);
  const none = setup();
  none.orch.onClient({ type: 'retrieval_mode', mode: 'cloud-sim' });
  assert.ok(none.ws.some((e) => e.type === 'error'));
});

test('interject lag: time from the first partial with the contradicted word, labelled with the mode', async () => {
  const retrieval = { mode: 'cloud-sim' as RetrievalMode, delayMs: 300 };
  const s = setup({ retrieval });
  begin(s, 't1', 'Draft a message to Priya saying');
  s.orch.onVoiceEvent(partial('t1', "Draft a message to Priya saying I'll see her Thursday"));
  const saidAt = Date.now();
  s.orch.onVoiceEvent(partial('t1', "Draft a message to Priya saying I'll see her Thursday at 2"));
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  await new Promise((r) => setTimeout(r, 40));
  s.orch.onTrackerEvent({ type: 'interject', turnId: 't1', text: INTERJECT });
  const lag = s.ws.find((e) => e.type === 'metric' && e.label === 'interject_lag:cloud-sim');
  assert.ok(lag && lag.type === 'metric');
  assert.ok(lag.ms >= 39 && lag.ms <= Date.now() - saidAt + 5, String(lag.ms));
});
