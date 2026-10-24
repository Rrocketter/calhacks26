// Moss SessionIndex spike for conversation memory: in-process addDocs (upsert), query next to the
// corpus, pushIndex to the cloud, and a reload. Deletes the pushed `ahead-memory` index at the end.
import { MossClient, isMossError, type DocumentInfo } from '@moss-js/moss';
import { MOSS_INDEX } from '@ahead/contracts';
import { requireEnv } from '../src/env.js';

const NAME = 'ahead-memory';
const QUERIES = ['what did I tell priya', 'priya', 'message to priya friday'];
const DOCS: DocumentInfo[] = [
  {
    id: 'memory-spike-1',
    text: 'Draft a message to Priya saying I\'ll see her Friday at noon. draft_message person=Priya day=friday. Outcome: committed.',
    metadata: { type: 'memory', date: '2026-10-24', people: 'Priya' },
  },
  {
    id: 'memory-spike-1-artifact',
    text: 'Told Priya Shah (messages/outbox/priya.md): Hi Priya, I\'ll see you Friday at noon.',
    metadata: { type: 'memory', date: '2026-10-24', people: 'Priya' },
  },
];

const ms = (t: number) => `${(performance.now() - t).toFixed(1)}ms`;

async function main(): Promise<void> {
  const client = new MossClient(requireEnv('MOSS_PROJECT_ID'), requireEnv('MOSS_PROJECT_KEY'));
  try {
    console.log('indexes:', (await client.listIndexes()).map((i) => i.name).join(', '));
    let t = performance.now();
    await client.loadIndex(MOSS_INDEX.corpus);
    console.log(`corpus loadIndex ${ms(t)}`);

    t = performance.now();
    const s = await client.session(NAME);
    console.log(`session() ${ms(t)}`);
    t = performance.now();
    try {
      console.log(`session.loadIndex -> ${await s.loadIndex(NAME)} docs ${ms(t)}`);
    } catch (err) {
      console.log(`session.loadIndex failed ${ms(t)}: ${isMossError(err) ? err.code : ''} ${String(err).slice(0, 160)}`);
    }

    t = performance.now();
    console.log(`addDocs #1 ${JSON.stringify(await s.addDocs([DOCS[0]!]))} ${ms(t)}`);
    t = performance.now();
    console.log(`addDocs #2 ${JSON.stringify(await s.addDocs([DOCS[1]!]))} ${ms(t)}`);
    t = performance.now();
    console.log(`addDocs upsert ${JSON.stringify(await s.addDocs([DOCS[0]!], { upsert: true }))} ${ms(t)}`);

    for (const q of QUERIES) {
      t = performance.now();
      const m = await s.query(q, { topK: 3, alpha: 0.3 });
      const mt = ms(t);
      t = performance.now();
      const c = await client.query(MOSS_INDEX.corpus, q, { topK: 3, alpha: 0.3 });
      const ct = ms(t);
      console.log(`"${q}" memory ${mt}: ${m.docs.map((d) => `${d.id}=${d.score.toFixed(3)}`).join(' ')}`);
      console.log(`"${q}" corpus ${ct}: ${c.docs.map((d) => `${d.id}=${d.score.toFixed(3)}`).join(' ')}`);
    }

    t = performance.now();
    console.log(`pushIndex ${JSON.stringify(await s.pushIndex())} ${ms(t)}`);
    console.log('indexes:', (await client.listIndexes()).map((i) => i.name).join(', '));

    const s2 = await client.session(`${NAME}`);
    t = performance.now();
    console.log(`reload session.loadIndex -> ${await s2.loadIndex(NAME)} docs ${ms(t)}`);
    t = performance.now();
    const r = await s2.query('what did I tell priya', { topK: 2, alpha: 0.3 });
    console.log(`reloaded query ${ms(t)}: ${r.docs.map((d) => d.id).join(' ')}`);

    await client.deleteIndex(NAME);
    console.log('deleted', NAME, 'indexes:', (await client.listIndexes()).map((i) => i.name).join(', '));
  } finally {
    await client.close();
  }
}

await main();
