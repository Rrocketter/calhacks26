import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Belief, Claim, ClientEvent, MossHit, ServerEvent, State } from '@ahead/contracts';
import { Orchestrator, type TrackerPort } from './orchestrator.js';
import { APPLIED_REPLY, DISCARDED_REPLY, FALLBACK_REPLY } from './reply.js';

type Call = { name: string; args: unknown[] };
type Opts = {
  tracker?: boolean;
  demo?: boolean;
  answer?: (q: string, hits: MossHit[]) => Promise<string>;
  /** Belief returned by tracker.onTurnEnd, per turn. */
  finalBelief?: (turnId: string) => Belief;
  /** When true, tracker.onTurnEnd also emits the final belief as a belief_update (like the real tracker). */
  emitFinal?: boolean;
  correctionTimeoutMs?: number;
  /** Speculator fake answers onConfirm with COMMITTED / ROLLED_BACK synchronously. */
  autoState?: boolean;
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
const INTERJECT = 'Quick note, your meeting with Priya is Friday at two, not Thursday. Want me to say Friday?';

function setup(opts: Opts = {}) {
  const calls: Call[] = [];
  const ws: ServerEvent[] = [];
  const specEvents: ServerEvent[] = [];
  const spoken: { text: string; opts: { interrupt: boolean; turnId: string } }[] = [];
  const rec = (name: string, args: unknown[]) => calls.push({ name, args });
  const tracker: TrackerPort = {
    onUpdate: async (t, text) => void rec('tracker.onUpdate', [t, text]),
    onEagerEnd: async (t, text) => void rec('tracker.onEagerEnd', [t, text]),
    onResume: (t) => void rec('tracker.onResume', [t]),
    onTurnEnd: async (t, text) => {
      rec('tracker.onTurnEnd', [t, text]);
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
  });
  const names = () => calls.map((c) => c.name);
  const specTypes = () => specEvents.map((e) => `${e.type}:${'turnId' in e ? e.turnId : ''}`);
  const texts = () => spoken.map((s) => s.text);
  return { orch, calls, ws, specEvents, spoken, names, specTypes, texts };
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

/** Turn t1 speculates a draft to Priya and is STAGED after its turn end. */
async function stagedTurn(s: S) {
  s.orch.onVoiceEvent(start('t1'));
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
  s.orch.onVoiceEvent(start('t1'));
  s.orch.onTrackerEvent(bu('t1', belief('lookup')));
  s.orch.onTrackerEvent({ type: 'moss_hits', turnId: 't1', query: 'q', hits: [], latencyMs: 2 });
  s.orch.onTrackerEvent({ type: 'metric', source: 'moss', label: 'query', ms: 2 });
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'belief_update:t1', 'moss_hits:t1']);
  assert.deepEqual(s.ws.map((e) => e.type), ['turn_start', 'belief_update', 'moss_hits', 'metric']);
});

test('tracker interject calls voice.handleInterject and is not sent to ws directly', () => {
  const s = setup();
  s.orch.onVoiceEvent(start('t1'));
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
  assert.deepEqual(s.specTypes(), ['turn_start:t1', 'turn_end:t1', 'turn_start:t2']);
  assert.deepEqual(
    s.ws.map((e) => `${e.type}:${'turnId' in e ? e.turnId : ''}`),
    ['turn_start:t1', 'transcript_partial:t1', 'turn_end:t1', 'turn_start:t2'],
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

test('speculative intent while SPECULATING speaks nothing at turn end; STAGED later speaks "I drafted a message to Priya. Apply?"', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  s.orch.onVoiceEvent(start('t1'));
  s.orch.onTrackerEvent(bu('t1', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('t1', 'SPECULATING'));
  s.orch.onVoiceEvent(final('t1', 'Draft a message to Priya'));
  s.orch.onVoiceEvent(end('t1'));
  s.orch.onVoiceTurnEnd('t1', 'Draft a message to Priya');
  await settle();
  assert.equal(s.spoken.length, 0);
  s.orch.onSpeculatorEvent(sc('t1', 'STAGED'));
  assert.deepEqual(s.spoken, [
    { text: 'I drafted a message to Priya. Apply?', opts: { interrupt: false, turnId: 't1' } },
  ]);
  assert.ok(s.ws.some((e) => e.type === 'state_change' && e.state === 'STAGED'));
});

test('STAGED before turn end speaks at turn end', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  s.orch.onVoiceEvent(start('t1'));
  s.orch.onTrackerEvent(bu('t1', belief('draft_message', { person: 'Priya Shah' })));
  s.orch.onSpeculatorEvent(sc('t1', 'SPECULATING'));
  s.orch.onSpeculatorEvent(sc('t1', 'STAGED'));
  assert.equal(s.spoken.length, 0);
  s.orch.onVoiceEvent(end('t1'));
  s.orch.onVoiceTurnEnd('t1', 'Draft a message to Priya');
  await settle();
  assert.deepEqual(s.texts(), ['I drafted a message to Priya. Apply?']);
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
  assert.deepEqual(s.texts(), ['I drafted a message to Priya. Apply?', APPLIED_REPLY]);
  assert.ok(s.calls.some((c) => c.name === 'tracker.onTurnEnd' && c.args[0] === 't2'));
});

test('spoken "No." after STAGED calls onConfirm(stagedTurn, false) and speaks "Okay, I dropped it." on ROLLED_BACK', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }), autoState: true });
  await stagedTurn(s);
  const before = s.specEvents.length;
  utter(s, 't2', 'No.');
  await settle();
  assert.deepEqual(s.calls.filter((c) => c.name === 'spec.onConfirm').map((c) => c.args), [['t1', false]]);
  assert.equal(s.specEvents.length, before);
  assert.deepEqual(s.texts(), ['I drafted a message to Priya. Apply?', DISCARDED_REPLY]);
});

test('non-confirm utterance after STAGED releases held turn_start and partials to the speculator in order', async () => {
  const s = setup({ finalBelief: () => belief('draft_message', { person: 'Priya Shah' }) });
  await stagedTurn(s);
  const before = s.specEvents.length;
  s.orch.onVoiceEvent(start('t2'));
  s.orch.onVoiceEvent(partial('t2', 'No'));
  s.orch.onTrackerEvent(bu('t2', belief('unknown')));
  assert.equal(s.specEvents.length, before, 'held while it may be a confirm');
  s.orch.onVoiceEvent(partial('t2', 'No, move my meeting'));
  assert.deepEqual(s.specTypes().slice(before), ['turn_start:t2', 'belief_update:t2']);
  s.orch.onVoiceEvent(eager('t2', 'No, move my meeting'));
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
    [['demo.start', 'demo-utterance-2'], ['demo.start', 'demo-utterance-1'], ['demo.stop']],
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
  s.orch.onVoiceEvent(start('t1'));
  s.orch.onSpeculatorEvent(sc('t1', 'LISTENING'));
  s.orch.close();
  assert.deepEqual(s.names(), ['voice.close']);
});

// ---- interject correction ----

const draft = (day: string, claims: Claim[] = [DAY_CLAIM]) =>
  belief('draft_message', { person: 'Priya Shah', day }, claims);

/** Turn t1 with an interject after the claim-carrying belief_update; ends the turn. */
async function interjectedTurn(s: S) {
  s.orch.onVoiceEvent(start('t1'));
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  s.orch.onTrackerEvent({ type: 'interject', turnId: 't1', text: INTERJECT });
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  s.orch.onVoiceEvent(eager('t1', "Draft a message to Priya saying I'll see her Thursday"));
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

test('spoken "Yes." after an interject flushes the deferred events with day friday in every belief_update, speaks "Okay, Friday.", and does not call onConfirm', async () => {
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
  assert.deepEqual(s.texts(), ['Okay, Friday.']);
  assert.equal(s.calls.filter((c) => c.name === 'spec.onConfirm').length, 0);
  // Later belief_updates of t1 are corrected too, and STAGED asks with the corrected belief.
  s.orch.onTrackerEvent(bu('t1', draft('thursday')));
  const last = s.specEvents.at(-1);
  assert.ok(last?.type === 'belief_update' && last.belief.entities.day === 'friday');
  s.orch.onSpeculatorEvent(sc('t1', 'STAGED'));
  assert.deepEqual(s.texts(), ['Okay, Friday.', 'I drafted a message to Priya. Apply?']);
});

test('spoken "No." after an interject flushes unchanged beliefs and speaks "Okay, Thursday."', async () => {
  const s = setup(correctionOpts);
  await interjectedTurn(s);
  utter(s, 't2', 'No.');
  await settle();
  const flushed = s.specEvents.slice(2);
  assert.equal(flushed.length, 4);
  for (const e of flushed) if (e.type === 'belief_update') assert.equal(e.belief.entities.day, 'thursday');
  assert.deepEqual(s.texts(), ['Okay, Thursday.']);
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
