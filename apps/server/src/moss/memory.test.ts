import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Belief } from '@ahead/contracts';
import type { RetrievedHit } from '../belief/types.js';
import {
  MEMORY_K,
  MEMORY_RANK,
  MemoryStore,
  artifactMemoryDoc,
  beliefSummary,
  isMemoryHit,
  mergeHits,
  turnMemoryDoc,
  type MemoryDoc,
  type MemorySession,
} from './memory.js';

const hit = (docId: string, score = 0.5): RetrievedHit => ({ docId, score, snippet: docId, metadata: {} });
const belief = (intent: Belief['intent'], entities: Record<string, string>): Belief => ({
  intent,
  entities,
  claims: [],
  confidence: 0.9,
  topHits: [],
  latencyMs: { moss: 1 },
});

test('mergeHits keeps the corpus top MEMORY_RANK, then memory, then the rest, capped at k', () => {
  const corpus = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => hit(id));
  const memory = ['memory-a', 'memory-b', 'memory-c'].map((id) => hit(id, 0.9));
  const ids = mergeHits(corpus, memory, 5).map((h) => h.docId);
  assert.equal(MEMORY_RANK, 3);
  assert.equal(MEMORY_K, 2);
  assert.deepEqual(ids, ['c1', 'c2', 'c3', 'memory-a', 'memory-b']);
  assert.deepEqual(mergeHits(corpus, [], 5).map((h) => h.docId), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(mergeHits([hit('c1')], memory, 5).map((h) => h.docId), ['c1', 'memory-a', 'memory-b']);
});

test('isMemoryHit matches the memory doc prefix only', () => {
  assert.equal(isMemoryHit('memory-t-1'), true);
  assert.equal(isMemoryHit('contact-priya'), false);
});

test('turnMemoryDoc holds the transcript, a one-line belief summary and the outcome', () => {
  const b = belief('draft_message', { person: 'Priya', day: 'friday', time: '' });
  assert.equal(beliefSummary(b), 'draft_message person=Priya day=friday');
  assert.equal(beliefSummary(undefined), 'unknown');
  const doc = turnMemoryDoc({ turnId: 't-1', date: '2026-10-24', text: ' Draft a message to Priya ', belief: b, outcome: 'committed' });
  assert.deepEqual(doc, {
    id: 'memory-t-1',
    text: 'User said: "Draft a message to Priya" Understood: draft_message person=Priya day=friday. Outcome: committed.',
    metadata: { type: 'memory', date: '2026-10-24', people: 'Priya', outcome: 'committed' },
  });
});

const DRAFT_DIFF = [
  'diff --git a/messages/outbox/priya.md b/messages/outbox/priya.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/messages/outbox/priya.md',
  '@@ -0,0 +1,3 @@',
  '+To: Priya Shah <priya.shah@example.com>',
  '+',
  "+Hi Priya, I'll see you Friday at noon.",
].join('\n');

test('artifactMemoryDoc stores a committed draft as what the user told the recipient', () => {
  const doc = artifactMemoryDoc({
    turnId: 't-1',
    date: '2026-10-24',
    belief: belief('draft_message', { person: 'Priya' }),
    diffs: [{ file: 'messages/outbox/priya.md', diff: DRAFT_DIFF }],
  });
  assert.deepEqual(doc, {
    id: 'memory-t-1-artifact',
    text: "Told Priya in a message on 2026-10-24. messages/outbox/priya.md: To: Priya Shah <priya.shah@example.com> Hi Priya, I'll see you Friday at noon.",
    metadata: { type: 'memory', date: '2026-10-24', people: 'Priya', outcome: 'committed' },
  });
});

test('artifactMemoryDoc stores a calendar edit as old to new; null without changed lines', () => {
  const diff = ['--- a/calendar.json', '+++ b/calendar.json', '@@ -3 +3 @@', '-  "day": "thursday",', '+  "day": "monday",'].join('\n');
  const doc = artifactMemoryDoc({
    turnId: 't-2',
    date: '2026-10-24',
    belief: belief('reschedule_event', { person: 'Priya Shah' }),
    diffs: [{ file: 'calendar.json', diff }],
  });
  assert.equal(doc?.text, 'Committed reschedule_event for Priya Shah on 2026-10-24. calendar.json: changed "day": "thursday", to "day": "monday",');
  assert.equal(artifactMemoryDoc({ turnId: 't-3', date: '2026-10-24', diffs: [] }), null);
});

function fakeStore(opts: { inCloud?: boolean; gate?: () => Promise<void>; failPersist?: boolean } = {}) {
  const docs = new Map<string, MemoryDoc>();
  const persisted: string[] = []; // 'push' or 'add:<ids>'
  const persist = async (what: string) => {
    persisted.push(what);
    await opts.gate?.();
    if (opts.failPersist) throw new Error('usage limit');
  };
  const session: MemorySession = {
    addDocs: async (ds, o) => {
      let added = 0;
      let updated = 0;
      for (const d of ds) {
        if (docs.has(d.id)) {
          assert.equal(o?.upsert, true);
          updated++;
        } else added++;
        docs.set(d.id, d);
      }
      return { added, updated };
    },
    query: async (q) => ({
      docs: [...docs.values()]
        .filter((d) => d.text.toLowerCase().includes(q.toLowerCase()))
        .map((d) => ({ id: d.id, text: d.text, metadata: d.metadata, score: 0.8 })),
      query: q,
      timeTakenInMs: 1,
    }),
    pushIndex: () => persist('push'),
  };
  const store = new MemoryStore(session, (ds) => persist(`add:${ds.map((d) => d.text).join(',')}`), opts.inCloud ?? false);
  return { store, docs, persisted };
}

const doc = (id: string, text = id): MemoryDoc => ({ id, text, metadata: { type: 'memory' } });

test('MemoryStore upserts in process and the next query sees it', async () => {
  const f = fakeStore();
  await f.store.add(doc('memory-t-1', 'Told Priya Friday'));
  await f.store.add(doc('memory-t-1', 'Told Priya Friday at noon'));
  assert.equal(f.docs.size, 1);
  const { hits } = await f.store.query('priya', { alpha: 0.3 });
  assert.equal(hits[0]?.docId, 'memory-t-1');
  assert.equal(hits[0]?.snippet, 'Told Priya Friday at noon');
  await f.store.flushed();
});

test('MemoryStore creates the cloud index once with pushIndex, then upserts changed docs, one persist at a time', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fakeStore({ gate: () => gate });
  await f.store.add(doc('memory-a')); // resolves before the persist finishes
  await f.store.add(doc('memory-b', 'b1'));
  await f.store.add(doc('memory-b', 'b2'));
  await f.store.add(doc('memory-c'));
  assert.deepEqual(f.persisted, ['push']);
  release();
  await f.store.flushed();
  assert.deepEqual(f.persisted, ['push', 'add:b2,memory-c']);
});

test('MemoryStore upserts into an existing cloud index without pushing', async () => {
  const f = fakeStore({ inCloud: true });
  await f.store.add(doc('memory-a'));
  await f.store.flushed();
  assert.deepEqual(f.persisted, ['add:memory-a']);
});

test('MemoryStore keeps working when a persist fails and retries the batch on the next write', async () => {
  const f = fakeStore({ inCloud: true, failPersist: true });
  await f.store.add(doc('memory-a', 'priya'));
  await f.store.flushed();
  const { hits } = await f.store.query('priya', { alpha: 0.3 });
  assert.equal(hits.length, 1);
  await f.store.add(doc('memory-b'));
  await f.store.flushed();
  assert.deepEqual(f.persisted, ['add:priya', 'add:priya,memory-b']);
});
