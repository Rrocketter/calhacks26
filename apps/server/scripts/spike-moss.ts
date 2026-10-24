import { MossClient, isMossError, type DocumentInfo } from '@moss-js/moss';
import { MOSS_INDEX } from '@ahead/contracts';
import { requireEnv } from '../src/env.js';
import { logLatency } from '../src/log.js';

const DOCS: DocumentInfo[] = [
  { id: 'evt-priya-q3', text: 'Calendar event: Q3 deck review with Priya Shah, Friday 2 PM, Conference Room B', metadata: { type: 'calendar', date: '2026-10-30', people: 'Priya Shah' } },
  { id: 'file-q3-deck', text: 'File files/q3-deck.pdf: the Q3 deck, roadmap and board slides', metadata: { type: 'file', date: '2026-10-20', people: 'Priya Shah' } },
  { id: 'contact-priya', text: 'Contact Priya Shah, head of product, priya.shah@example.com, owns the Q3 deck review', metadata: { type: 'contact', date: '', people: 'Priya Shah' } },
  { id: 'evt-lunch', text: 'Calendar event: lunch with Marcus Lee at Tartine, Mission', metadata: { type: 'calendar', date: '2026-10-27', people: 'Marcus Lee' } },
  { id: 'evt-offsite', text: 'Calendar event: offsite prep, book the venue and catering', metadata: { type: 'calendar', date: '2026-11-02', people: 'Dana Kim' } },
  { id: 'file-budget', text: 'File files/budget-2026.xlsx: annual budget spreadsheet with headcount lines', metadata: { type: 'file', date: '2026-09-15', people: '' } },
  { id: 'contact-marcus', text: 'Contact Marcus Lee, engineering lead, marcus.lee@example.com', metadata: { type: 'contact', date: '', people: 'Marcus Lee' } },
  { id: 'note-groceries', text: 'Note: buy oat milk, eggs, and coffee beans on the way home', metadata: { type: 'note', date: '2026-10-21', people: '' } },
  { id: 'note-gym', text: 'Note: gym schedule, leg day Tuesday and Thursday mornings', metadata: { type: 'note', date: '2026-10-19', people: '' } },
  { id: 'note-flight', text: 'Note: flight to Seattle boards at 6:40 AM, check in the night before', metadata: { type: 'note', date: '2026-11-05', people: 'Dana Kim' } },
];

const PHRASINGS = [
  'draft a message to Priya',
  'meeting with Priya Thursday',
  'q3 deck',
  'what time is my Priya meeting',
];

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

async function main(): Promise<void> {
  const client = new MossClient(requireEnv('MOSS_PROJECT_ID'), requireEnv('MOSS_PROJECT_KEY'));
  const name = MOSS_INDEX.spike;
  try {
    const existing = await client.listIndexes();
    if (existing.some((i) => i.name === name)) {
      await client.deleteIndex(name);
      console.log(`[moss] deleted existing index ${name}`);
    }

    let t = performance.now();
    await client.createIndex(name, DOCS, { modelId: 'moss-minilm' });
    logLatency('moss', 'createIndex (upload+build)', performance.now() - t);

    t = performance.now();
    await client.loadIndex(name);
    logLatency('moss', 'loadIndex', performance.now() - t);

    t = performance.now();
    await client.query(name, 'warmup', { topK: 3 });
    logLatency('moss', 'warmup query', performance.now() - t);

    const wall: number[] = [];
    const sdk: number[] = [];
    const top = new Map<string, string>();
    for (let i = 0; i < 20; i++) {
      const phrase = PHRASINGS[i % PHRASINGS.length]!;
      const start = performance.now();
      const res = await client.query(name, phrase, { topK: 3 });
      wall.push(performance.now() - start);
      if (res.timeTakenInMs !== undefined) sdk.push(res.timeTakenInMs);
      if (!top.has(phrase)) top.set(phrase, res.docs[0] ? `${res.docs[0].id} (score ${res.docs[0].score.toFixed(3)})` : 'none');
    }
    for (const [phrase, hit] of top) console.log(`[moss] top "${phrase}" -> ${hit}`);
    const w = [...wall].sort((a, b) => a - b);
    const s = [...sdk].sort((a, b) => a - b);
    logLatency('moss', 'query p50', pct(w, 50));
    logLatency('moss', 'query p95', pct(w, 95));
    if (s.length) {
      logLatency('moss', 'sdk timeTakenInMs p50', pct(s, 50));
      logLatency('moss', 'sdk timeTakenInMs p95', pct(s, 95));
    } else console.log('[moss] sdk timeTakenInMs not reported');
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  if (isMossError(err)) console.error(`[moss] error ${err.code} ${err.message}`);
  else console.error(`[moss] error ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
