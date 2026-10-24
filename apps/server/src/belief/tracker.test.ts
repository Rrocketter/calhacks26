import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerEvent, type MossHit, type ServerEvent } from '@ahead/contracts';
import { BeliefTracker } from './tracker.js';
import type { IntentLlm, IntentResult, RetrievedHit, Retriever } from './types.js';

const CONTACTS = [{ name: 'Priya Shah' }, { name: 'Marcus Lee' }];

class FakeRetriever implements Retriever {
  calls: string[] = [];
  constructor(private table: Record<string, RetrievedHit[]> = {}) {}
  async query(text: string) {
    this.calls.push(text);
    return { hits: this.table[text] ?? [], latencyMs: 1.5 };
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type LlmOut = { result: IntentResult; latencyMs: number };

class FakeLlm implements IntentLlm {
  calls: { partial: string; topHits: MossHit[]; final?: boolean }[] = [];
  pending: Deferred<LlmOut>[] = [];
  inFlight = 0;
  maxInFlight = 0;
  classify(input: { partial: string; topHits: MossHit[]; final?: boolean }): Promise<LlmOut> {
    this.calls.push(input);
    const d = deferred<LlmOut>();
    this.pending.push(d);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const done = () => {
      this.inFlight--;
    };
    d.promise.then(done, done);
    return d.promise;
  }
  resolve(i: number, result: Partial<IntentResult>, latencyMs = 300) {
    this.pending[i]!.resolve({
      result: { intent: 'unknown', entities: {}, claims: [], confidence: 0, ...result },
      latencyMs,
    });
  }
}

/** An llm that answers immediately with a fixed result. */
class InstantLlm implements IntentLlm {
  calls = 0;
  constructor(private result: Partial<IntentResult>) {}
  async classify() {
    this.calls++;
    return {
      result: { intent: 'unknown' as const, entities: {}, claims: [], confidence: 0, ...this.result },
      latencyMs: 200,
    };
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function hit(docId: string, metadata: Record<string, string>, snippet = docId): RetrievedHit {
  return { docId, score: 0.5, snippet, metadata };
}

function setup(opts: {
  retriever?: Retriever;
  llm?: IntentLlm;
  today?: Date;
}) {
  const events: ServerEvent[] = [];
  const retriever = opts.retriever ?? new FakeRetriever();
  const llm = opts.llm ?? new FakeLlm();
  const tracker = new BeliefTracker({
    retriever,
    llm,
    contacts: CONTACTS,
    emit: (ev) => events.push(ev),
    today: () => opts.today ?? new Date(2026, 9, 24),
  });
  return { tracker, events, retriever, llm };
}

const ofType = <T extends ServerEvent['type']>(events: ServerEvent[], type: T) =>
  events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);

test('emits moss_hits per query and a belief_update per changed partial', async () => {
  const { tracker, events, retriever } = setup({});
  await tracker.onUpdate('t1', 'Can you please draft a message to Priya');
  const r = retriever as FakeRetriever;
  // full text, last 6 words, person
  assert.deepEqual(r.calls.sort(), [
    'can you please draft a message to priya',
    'please draft a message to priya',
    'priya shah',
  ]);
  assert.equal(ofType(events, 'moss_hits').length, 3);
  const metrics = ofType(events, 'metric');
  assert.equal(metrics.length, 3);
  assert.ok(metrics.every((m) => m.source === 'moss' && m.label === 'query'));
  assert.equal(ofType(events, 'belief_update').length, 1);

  // short text: last 6 words equals the full text, so it is deduped
  const s = setup({});
  await s.tracker.onUpdate('t1', 'draft a message to priya');
  assert.deepEqual((s.retriever as FakeRetriever).calls.sort(), [
    'draft a message to priya',
    'priya shah',
  ]);
  assert.equal(ofType(s.events, 'moss_hits').length, 2);
});

test('every emitted event parses with parseServerEvent', async () => {
  const llm = new FakeLlm();
  const retriever = new FakeRetriever({
    'priya shah': [hit('contact-priya', { type: 'contact', people: 'Priya Shah' })],
  });
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft');
  await tracker.onUpdate('t1', 'draft a message to Priya on Thursday');
  llm.resolve(0, { intent: 'draft_message', entities: { person: 'Priya' }, confidence: 0.9 });
  await tracker.idle();
  llm.pending.slice(1).forEach((_, i) => llm.resolve(i + 1, { intent: 'draft_message' }));
  await tracker.idle();
  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.ok(parseServerEvent(JSON.stringify(ev)), `does not parse: ${JSON.stringify(ev)}`);
  }
});

test('unchanged text is skipped', async () => {
  const llm = new FakeLlm();
  const { tracker, events, retriever } = setup({ llm });
  await tracker.onUpdate('t1', 'draft a message to priya');
  const n = events.length;
  const q = (retriever as FakeRetriever).calls.length;
  const l = llm.calls.length;
  await tracker.onUpdate('t1', 'Draft a message to Priya.');
  assert.equal(events.length, n);
  assert.equal((retriever as FakeRetriever).calls.length, q);
  assert.equal(llm.calls.length, l);
});

test('moss alone never locks', async () => {
  const llm = new FakeLlm(); // never resolves
  const retriever = new FakeRetriever({
    'priya shah': [hit('contact-priya', { type: 'contact', people: 'Priya Shah' })],
    'draft a message to priya': [hit('contact-priya', { type: 'contact', people: 'Priya Shah' })],
  });
  const { tracker } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya');
  const b = tracker.current('t1');
  assert.ok(b);
  assert.equal(b.intent, 'unknown');
  assert.ok(b.confidence <= 0.5, `confidence ${b.confidence}`);
  assert.equal(tracker.isLocked('t1'), false);
});

test('entities include weekday and date_iso', async () => {
  const { tracker } = setup({ today: new Date(2026, 9, 24) });
  await tracker.onUpdate('t1', 'draft a message to priya saying i will see her thursday');
  const b = tracker.current('t1')!;
  assert.equal(b.entities.weekday, 'thursday');
  assert.equal(b.entities.date_iso, '2026-10-29');
  assert.equal(b.entities.person, 'Priya Shah');
});

test('entities include to_weekday and to_date_iso for "to <day>"', async () => {
  const { tracker } = setup({ today: new Date(2026, 9, 24) });
  await tracker.onUpdate('t1', 'move my friday meeting with priya to monday');
  const b = tracker.current('t1')!;
  assert.equal(b.entities.weekday, 'friday');
  assert.equal(b.entities.date_iso, '2026-10-30');
  assert.equal(b.entities.to_weekday, 'monday');
  assert.equal(b.entities.to_date_iso, '2026-10-26');
});

test('locks draft_message + Priya when llm agrees and moss supports person', async () => {
  const llm = new InstantLlm({
    intent: 'draft_message',
    entities: { person: 'Priya' },
    confidence: 0.9,
  });
  const retriever = new FakeRetriever({
    'priya shah': [hit('contact-priya', { type: 'contact', people: 'Priya Shah' })],
  });
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya'); // new entity -> llm call
  await tracker.idle();
  const b = tracker.current('t1')!;
  assert.equal(b.intent, 'draft_message');
  assert.ok(Math.abs(b.confidence - 0.94) < 1e-9, `confidence ${b.confidence}`);
  assert.equal(b.entities.person, 'Priya Shah');
  assert.equal(b.latencyMs.llm, 200);
  assert.equal(b.topHits[0]!.docId, 'contact-priya');
  assert.equal(tracker.isLocked('t1'), true);
  // belief_update after moss and again after the llm result
  assert.equal(ofType(events, 'belief_update').length, 2);
});

test('llm called every Nth update and on new entity, never concurrently', async () => {
  const llm = new FakeLlm();
  const { tracker } = setup({ llm });
  await tracker.onUpdate('t1', 'draft'); // 1st changed update, no entity
  assert.equal(llm.calls.length, 0);
  await tracker.onUpdate('t1', 'draft a'); // 2nd -> call
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0]!.partial, 'draft a');
  await tracker.onUpdate('t1', 'draft a message to priya'); // new entity, but in flight
  await tracker.onUpdate('t1', 'draft a message to priya saying'); // 4th, in flight
  assert.equal(llm.calls.length, 1);
  llm.resolve(0, { intent: 'draft_message', confidence: 0.5 });
  await tick();
  // exactly one follow-up call, with the latest text
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[1]!.partial, 'draft a message to priya saying');
  llm.resolve(1, { intent: 'draft_message', confidence: 0.5 });
  await tracker.idle();
  assert.equal(llm.calls.length, 2);

  await tracker.onUpdate('t1', 'draft a message to priya saying hi'); // 5th, no new entity
  assert.equal(llm.calls.length, 2);
  await tracker.onUpdate('t1', 'draft a message to priya saying hi thursday'); // new entity
  assert.equal(llm.calls.length, 3);
  llm.resolve(2, { intent: 'draft_message', confidence: 0.5 });
  await tracker.idle();
  assert.equal(llm.maxInFlight, 1);
});

test('stale llm result is dropped', async () => {
  // Calls never overlap within a turn (see the previous test), so the newest applied result
  // always comes from the newest partial asked about. The older call's result applies first,
  // then the follow-up (latest text) replaces it and nothing older is applied afterwards.
  const llm = new FakeLlm();
  const { tracker, events } = setup({ llm });
  await tracker.onUpdate('t1', 'draft');
  await tracker.onUpdate('t1', 'draft a'); // call 0
  await tracker.onUpdate('t1', 'draft a message to priya'); // queued behind call 0
  llm.resolve(0, { intent: 'find_file', confidence: 0.3 }, 111);
  await tick();
  assert.equal(tracker.current('t1')!.intent, 'find_file');
  assert.equal(llm.calls[1]!.partial, 'draft a message to priya');
  llm.resolve(1, { intent: 'draft_message', entities: { person: 'Priya' }, confidence: 0.9 }, 222);
  await tracker.idle();
  const b = tracker.current('t1')!;
  assert.equal(b.intent, 'draft_message');
  assert.equal(b.latencyMs.llm, 222);
  const last = ofType(events, 'belief_update').at(-1)!;
  assert.equal(last.belief.intent, 'draft_message');
});

test('llm failure keeps moss loop running', async () => {
  const llm = new FakeLlm();
  const { tracker, events } = setup({ llm });
  await tracker.onUpdate('t1', 'draft');
  await tracker.onUpdate('t1', 'draft a');
  llm.pending[0]!.reject(new Error('overloaded'));
  await tracker.idle();
  const errors = ofType(events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.source, 'llm');
  assert.match(errors[0]!.message, /overloaded/);
  const before = ofType(events, 'belief_update').length;
  await tracker.onUpdate('t1', 'draft a message');
  await tracker.onUpdate('t1', 'draft a message to');
  assert.equal(ofType(events, 'belief_update').length, before + 2);
  assert.equal(tracker.current('t1')!.intent, 'unknown');
  assert.equal(tracker.isLocked('t1'), false);
});

test('confidence is clamped to [0,1]', async () => {
  const llm = new InstantLlm({ intent: 'draft_message', confidence: 1.7 });
  const retriever = new FakeRetriever({
    'priya shah': [hit('contact-priya', { type: 'contact', people: 'Priya Shah' })],
  });
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya');
  await tracker.idle();
  assert.equal(tracker.current('t1')!.confidence, 1);
  for (const ev of events) assert.ok(parseServerEvent(JSON.stringify(ev)));
});

test('overlapping updates for one turn are serialized', async () => {
  // Retriever whose answers for the first partial arrive after the second partial's.
  const gates = new Map<string, Deferred<void>>();
  const table: Record<string, RetrievedHit[]> = {
    'draft a message': [hit('doc-x', { type: 'note', people: '' })],
    'draft a message to priya': [hit('doc-y', { type: 'contact', people: 'Priya Shah' })],
  };
  const retriever: Retriever = {
    async query(text: string) {
      const g = deferred<void>();
      gates.set(text, g);
      await g.promise;
      return { hits: table[text] ?? [], latencyMs: 1 };
    },
  };
  const { tracker, events } = setup({ retriever });
  const a = tracker.onUpdate('t1', 'draft a message');
  const b = tracker.onUpdate('t1', 'draft a message to priya');
  await tick();
  // Release whatever is pending, newest first, until both updates are done.
  let done = false;
  void Promise.all([a, b]).then(() => (done = true));
  while (!done) {
    for (const k of [...gates.keys()].reverse()) {
      gates.get(k)!.resolve();
      gates.delete(k);
    }
    await tick();
  }
  const updates = ofType(events, 'belief_update');
  assert.equal(updates.length, 2);
  const last = updates.at(-1)!.belief;
  assert.equal(last.entities.person, 'Priya Shah');
  // decay applied once per update: doc-x 1*0.6 = 0.6 < doc-y 1
  assert.deepEqual(
    last.topHits.map((h) => h.docId),
    ['doc-y', 'doc-x'],
  );
  assert.equal(updates[0]!.belief.entities.person, undefined);
});

test('a failed update does not break later updates on the chain', async () => {
  const retriever: Retriever = {
    async query(text: string) {
      if (text === 'draft') throw new Error('moss down');
      return { hits: [], latencyMs: 1 };
    },
  };
  const { tracker, events } = setup({ retriever });
  const a = tracker.onUpdate('t1', 'draft');
  await assert.doesNotReject(a);
  await tracker.onUpdate('t1', 'draft a');
  const errors = ofType(events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.source, 'moss');
  assert.match(errors[0]!.message, /moss down/);
  assert.equal(ofType(events, 'belief_update').length, 1);
});

// ---- Task 5: contradiction, eager end, resume, turn end ----

/** Returns the same hits for every query, so accumulator ranks follow list order. */
class SameHitsRetriever implements Retriever {
  calls: string[] = [];
  constructor(private hits: RetrievedHit[]) {}
  async query(text: string) {
    this.calls.push(text);
    return { hits: this.hits, latencyMs: 1 };
  }
}

const PRIYA_EVT = hit(
  'evt-priya-q3',
  { type: 'calendar', people: 'Priya Shah', day: 'friday', time: '2 pm', title: 'Q3 review' },
  'Q3 review with Priya Shah, Friday 2 pm',
);
const PRIYA_CONTACT = hit('contact-priya', { type: 'contact', people: 'Priya Shah' });
const MARCUS_EVT = hit(
  'evt-marcus-sync',
  { type: 'calendar', people: 'Marcus Lee', day: 'friday', time: '10 am', title: 'Sync' },
  'Sync with Marcus Lee, Friday 10 am',
);
const DEMO_TEXT = "Heads up, Priya's meeting is Friday, not Thursday. Say Friday?";
const LOCKED_DRAFT = {
  intent: 'draft_message' as const,
  entities: { person: 'Priya' },
  confidence: 0.9,
};

test('fast-path day contradiction fires once when locked', async () => {
  const llm = new InstantLlm(LOCKED_DRAFT);
  const retriever = new SameHitsRetriever([PRIYA_EVT, PRIYA_CONTACT]);
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya');
  await tracker.idle();
  assert.equal(tracker.isLocked('t1'), true);
  assert.equal(ofType(events, 'interject').length, 0);
  await tracker.onUpdate('t1', 'draft a message to priya saying i will see her Thursday');
  await tracker.idle();
  const ij = ofType(events, 'interject');
  assert.equal(ij.length, 1);
  assert.equal(ij[0]!.text, DEMO_TEXT);
  assert.equal(ij[0]!.turnId, 't1');
  const claim = { field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-priya-q3' };
  const idx = events.indexOf(ij[0]!);
  const before = events[idx - 1]!;
  assert.equal(before.type, 'belief_update');
  assert.deepEqual(before.type === 'belief_update' && before.belief.claims, [claim]);
  assert.deepEqual(tracker.current('t1')!.claims, [claim]);

  await tracker.onUpdate('t1', 'draft a message to priya saying i will see her Thursday at 2');
  await tracker.idle();
  assert.equal(ofType(events, 'interject').length, 1);
  for (const ev of events) assert.ok(parseServerEvent(JSON.stringify(ev)));
});

test('interject fires when the lock arrives after the contradicting partial', async () => {
  const llm = new FakeLlm();
  const retriever = new SameHitsRetriever([PRIYA_EVT, PRIYA_CONTACT]);
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya'); // call 0 in flight
  await tracker.onUpdate('t1', 'draft a message to priya saying i will see her thursday');
  assert.equal(tracker.isLocked('t1'), false);
  assert.equal(ofType(events, 'interject').length, 0);
  llm.resolve(0, LOCKED_DRAFT);
  await tick();
  assert.equal(tracker.isLocked('t1'), true);
  const ij = ofType(events, 'interject');
  assert.equal(ij.length, 1);
  assert.equal(ij[0]!.text, DEMO_TEXT);
  llm.resolve(1, LOCKED_DRAFT);
  await tracker.idle();
  assert.equal(ofType(events, 'interject').length, 1);
});

test('no interject when not locked', async () => {
  const llm = new FakeLlm(); // never resolves
  const retriever = new SameHitsRetriever([PRIYA_EVT, PRIYA_CONTACT]);
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya');
  await tracker.onUpdate('t1', 'draft a message to priya saying i will see her thursday');
  assert.equal(tracker.isLocked('t1'), false);
  assert.equal(ofType(events, 'interject').length, 0);
});

test('no interject when the doc is not a strong hit (rank >= 3)', async () => {
  const llm = new InstantLlm(LOCKED_DRAFT);
  const retriever = new SameHitsRetriever([
    PRIYA_CONTACT,
    hit('note-a', { type: 'note', people: '' }),
    hit('note-b', { type: 'note', people: '' }),
    PRIYA_EVT,
  ]);
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya');
  await tracker.idle();
  await tracker.onUpdate('t1', 'draft a message to priya saying i will see her thursday');
  await tracker.idle();
  assert.equal(tracker.isLocked('t1'), true);
  assert.equal(ofType(events, 'interject').length, 0);
});

test('llm claim is verified against the doc', async () => {
  // Calendar doc is Marcus's, so the fast path (person Priya) finds no doc; only the llm claim.
  const retriever = new SameHitsRetriever([MARCUS_EVT, PRIYA_CONTACT]);
  const text = 'draft a message to priya saying i will see her thursday';
  const bad = new InstantLlm({
    ...LOCKED_DRAFT,
    claims: [{ field: 'day', said: 'Thursday', known: 'Wednesday', docId: 'evt-marcus-sync' }],
  });
  const a = setup({ llm: bad, retriever });
  await a.tracker.onUpdate('t1', text);
  await a.tracker.idle();
  assert.equal(a.tracker.isLocked('t1'), true);
  assert.equal(ofType(a.events, 'interject').length, 0);

  // control: the same claim with a known day that is in the doc does fire
  const good = new InstantLlm({
    ...LOCKED_DRAFT,
    claims: [{ field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-marcus-sync' }],
  });
  const b = setup({ llm: good, retriever });
  await b.tracker.onUpdate('t1', text);
  await b.tracker.idle();
  const ij = ofType(b.events, 'interject');
  assert.equal(ij.length, 1);
  assert.equal(ij[0]!.text, DEMO_TEXT);
});

test('same day after normalization is not a contradiction', async () => {
  const retriever = new SameHitsRetriever([MARCUS_EVT, PRIYA_CONTACT]);
  const llm = new InstantLlm({
    ...LOCKED_DRAFT,
    claims: [{ field: 'day', said: 'Friday,', known: 'friday', docId: 'evt-marcus-sync' }],
  });
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya saying i will see her Friday,');
  await tracker.idle();
  assert.equal(tracker.isLocked('t1'), true);
  assert.equal(ofType(events, 'interject').length, 0);
});

test('reschedule target day is not a contradiction', async () => {
  const retriever = new SameHitsRetriever([PRIYA_EVT, PRIYA_CONTACT]);
  const llm = new InstantLlm({
    intent: 'reschedule_event',
    entities: { person: 'Priya' },
    confidence: 0.9,
    claims: [{ field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-priya-q3' }],
  });
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'move my friday meeting with priya to thursday');
  await tracker.idle();
  assert.equal(tracker.isLocked('t1'), true);
  assert.equal(tracker.current('t1')!.entities.to_weekday, 'thursday');
  assert.equal(ofType(events, 'interject').length, 0);
});

test('fast-path time claim compares the hour only when no day is said', async () => {
  const retriever = new SameHitsRetriever([PRIYA_EVT, PRIYA_CONTACT]);
  const same = setup({ llm: new InstantLlm(LOCKED_DRAFT), retriever });
  await same.tracker.onUpdate('t1', 'draft a message to priya saying see you at 2');
  await same.tracker.idle();
  assert.equal(same.tracker.isLocked('t1'), true);
  assert.equal(ofType(same.events, 'interject').length, 0);

  const diff = setup({ llm: new InstantLlm(LOCKED_DRAFT), retriever });
  await diff.tracker.onUpdate('t1', 'draft a message to priya saying see you at 3');
  await diff.tracker.idle();
  const ij = ofType(diff.events, 'interject');
  assert.equal(ij.length, 1);
  assert.deepEqual(diff.tracker.current('t1')!.claims, [
    { field: 'time', said: '3', known: '2 pm', docId: 'evt-priya-q3' },
  ]);
});

test('eager end finalizes and resume un-finalizes', async () => {
  const llm = new InstantLlm(LOCKED_DRAFT);
  const retriever = new SameHitsRetriever([PRIYA_CONTACT]);
  const { tracker } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft');
  assert.equal(tracker.isFinalized('t1'), false);
  await tracker.onEagerEnd('t1', 'draft a message to priya');
  assert.equal(tracker.isFinalized('t1'), true);
  // the eager-end text was processed and its llm call applied before finalizing
  const b = tracker.current('t1')!;
  assert.equal(b.intent, 'draft_message');
  assert.equal(b.entities.person, 'Priya Shah');
  tracker.onResume('t1');
  assert.equal(tracker.isFinalized('t1'), false);
  assert.equal(tracker.current('t1'), b); // belief kept
  assert.equal(tracker.isLocked('t1'), true);
});

test('resume during a pending eager end leaves the turn un-finalized', async () => {
  const llm = new InstantLlm(LOCKED_DRAFT);
  const { tracker } = setup({ llm });
  const p = tracker.onEagerEnd('t1', 'draft a message to priya');
  tracker.onResume('t1');
  await p;
  assert.equal(tracker.isFinalized('t1'), false);
});

test('turn end makes one llm call and returns final belief', async () => {
  const llm = new InstantLlm(LOCKED_DRAFT);
  const retriever = new SameHitsRetriever([PRIYA_CONTACT]);
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya');
  await tracker.idle();
  const callsBefore = llm.calls;
  const b = await tracker.onTurnEnd('t1', 'draft a message to priya saying hi');
  assert.equal(llm.calls, callsBefore + 1);
  assert.equal(b.intent, 'draft_message');
  assert.equal(b.entities.person, 'Priya Shah');
  const last = ofType(events, 'belief_update').at(-1)!;
  assert.deepEqual(last.belief, b);
  assert.equal(tracker.current('t1'), undefined);
  assert.equal(tracker.isLocked('t1'), false);
});

test('turn end passes final flag, final text and topHits, after queued updates', async () => {
  const llm = new FakeLlm();
  const retriever = new SameHitsRetriever([PRIYA_CONTACT]);
  const { tracker } = setup({ llm, retriever });
  void tracker.onUpdate('t1', 'draft a message to priya'); // not awaited
  const p = tracker.onTurnEnd('t1', 'draft a message to priya saying hi');
  await tick();
  await tick();
  const finalCall = llm.calls.find((c) => c.final === true)!;
  assert.ok(finalCall, 'final call made');
  assert.equal(finalCall.partial, 'draft a message to priya saying hi');
  assert.deepEqual(
    finalCall.topHits.map((h) => h.docId),
    ['contact-priya'],
  );
  llm.pending.forEach((_, i) => llm.resolve(i, LOCKED_DRAFT));
  const b = await p;
  assert.equal(b.intent, 'draft_message');
});

test('late streaming result after the final call is dropped', async () => {
  const llm = new FakeLlm();
  const { tracker, events } = setup({ llm });
  await tracker.onUpdate('t1', 'draft');
  await tracker.onUpdate('t1', 'draft a'); // streaming call 0 in flight
  assert.equal(llm.calls.length, 1);
  const p = tracker.onTurnEnd('t1', 'draft a message to priya');
  await tick();
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[1]!.final, true);
  llm.resolve(1, LOCKED_DRAFT, 222);
  const b = await p;
  assert.equal(b.intent, 'draft_message');
  const n = events.length;
  llm.resolve(0, { intent: 'find_file', confidence: 0.99 }, 111); // late streaming result
  await tracker.idle();
  assert.equal(events.length, n, 'nothing emitted for the late result');
  assert.equal(ofType(events, 'belief_update').at(-1)!.belief.intent, 'draft_message');
  assert.equal(llm.calls.length, 2, 'no follow-up call after turn end');
});

test('turn end llm failure returns the last belief', async () => {
  const llm = new FakeLlm();
  const { tracker, events } = setup({ llm });
  await tracker.onUpdate('t1', 'draft');
  const last = tracker.current('t1')!;
  const p = tracker.onTurnEnd('t1', 'draft a');
  await tick();
  llm.pending.at(-1)!.reject(new Error('timeout'));
  const b = await p;
  assert.deepEqual(b, last);
  assert.ok(ofType(events, 'error').some((e) => e.source === 'llm'));
  assert.equal(tracker.current('t1'), undefined);
});

test('unknown turn is ignored', async () => {
  const llm = new FakeLlm();
  const { tracker, events } = setup({ llm });
  assert.doesNotThrow(() => tracker.onResume('nope'));
  const b = await tracker.onTurnEnd('nope', 'hello');
  assert.equal(b.intent, 'unknown');
  assert.equal(b.confidence, 0);
  assert.equal(llm.calls.length, 0);
  assert.equal(events.length, 0);
  assert.equal(tracker.current('nope'), undefined);
  assert.equal(tracker.isFinalized('nope'), false);
  assert.ok(parseServerEvent(JSON.stringify({ type: 'belief_update', turnId: 'nope', belief: b })));
});

test('no interject after the user stopped (turn end)', async () => {
  const llm = new InstantLlm(LOCKED_DRAFT);
  const retriever = new SameHitsRetriever([PRIYA_EVT, PRIYA_CONTACT]);
  const { tracker, events } = setup({ llm, retriever });
  await tracker.onUpdate('t1', 'draft a message to priya');
  await tracker.idle();
  assert.equal(tracker.isLocked('t1'), true);
  assert.equal(ofType(events, 'interject').length, 0);
  // contradiction only appears in the final text
  const b = await tracker.onTurnEnd('t1', 'draft a message to priya saying i will see her thursday');
  assert.equal(b.intent, 'draft_message');
  assert.equal(ofType(events, 'interject').length, 0);
});

test('updates and eager end queued after turn end are ignored', async () => {
  const llm = new FakeLlm();
  const { tracker, events, retriever } = setup({ llm });
  await tracker.onUpdate('t1', 'draft a message to priya'); // streaming call 0
  llm.resolve(0, LOCKED_DRAFT);
  await tracker.idle();
  const eventsBefore = events.length;
  const queriesBefore = (retriever as FakeRetriever).calls.length;
  const p = tracker.onTurnEnd('t1', 'draft a message to priya saying hi');
  const u = tracker.onUpdate('t1', 'draft a message to priya saying hi there');
  const e = tracker.onEagerEnd('t1', 'draft a message to priya saying hi there again');
  await tick();
  const finals = () => llm.calls.filter((c) => c.final === true).length;
  assert.equal(finals(), 1);
  llm.resolve(llm.calls.length - 1, LOCKED_DRAFT);
  const b = await p;
  await Promise.all([u, e]);
  await tracker.idle();
  const last = events.at(-1)!;
  assert.equal(last.type, 'belief_update');
  assert.deepEqual(last.type === 'belief_update' && last.belief, b);
  assert.equal(events.length, eventsBefore + 1, 'only the final belief_update after turn end');
  assert.equal((retriever as FakeRetriever).calls.length, queriesBefore, 'no moss after turn end');
  assert.equal(finals(), 1);
  assert.equal(llm.calls.length, 2, 'no streaming call after turn end');
  assert.equal(tracker.current('t1'), undefined);
  assert.equal(tracker.isFinalized('t1'), false);
});

test('duplicate turn end makes one llm call', async () => {
  const llm = new FakeLlm();
  const { tracker, events } = setup({ llm });
  await tracker.onUpdate('t1', 'draft');
  const p1 = tracker.onTurnEnd('t1', 'draft a');
  const p2 = tracker.onTurnEnd('t1', 'draft a');
  await tick();
  assert.equal(llm.calls.length, 1);
  llm.resolve(0, LOCKED_DRAFT);
  const [b1, b2] = await Promise.all([p1, p2]);
  await tracker.idle();
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(b2, b1);
  assert.equal(ofType(events, 'belief_update').length, 2); // one streaming, one final
});
