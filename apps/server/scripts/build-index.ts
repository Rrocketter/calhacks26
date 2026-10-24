import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MossClient, isMossError, type DocumentInfo } from '@moss-js/moss';
import { MOSS_INDEX } from '@ahead/contracts';
import { REPO_ROOT, requireEnv } from '../src/env.js';
import { logLatency } from '../src/log.js';
import { MossIndex } from '../src/moss/index.js';
import type { CorpusDoc } from '../src/belief/types.js';

const QUERIES = [
  'draft a message to priya',
  'priya thursday',
  'q3 deck',
  'what time is my priya meeting',
];

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

async function main(): Promise<void> {
  const file = path.join(REPO_ROOT, 'data', 'corpus', 'corpus.json');
  if (!existsSync(file)) {
    throw new Error(`missing ${file}; run: pnpm --filter @ahead/server gen:corpus`);
  }
  const corpus = JSON.parse(readFileSync(file, 'utf8')) as CorpusDoc[];
  // Moss metadata values must be strings; drop undefined optional keys.
  const docs: DocumentInfo[] = corpus.map((d) => ({
    id: d.id,
    text: d.text,
    metadata: Object.fromEntries(
      Object.entries(d.metadata).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  }));

  const client = new MossClient(requireEnv('MOSS_PROJECT_ID'), requireEnv('MOSS_PROJECT_KEY'));
  const name = MOSS_INDEX.corpus;
  try {
    const existing = await client.listIndexes();
    if (existing.some((i) => i.name === name)) {
      await client.deleteIndex(name);
      console.log(`[moss] deleted existing index ${name}`);
    }
    const t = performance.now();
    await client.createIndex(name, docs, { modelId: 'moss-minilm' });
    logLatency('moss', `createIndex ${docs.length} docs (upload+build)`, performance.now() - t);

    const index = await MossIndex.load(client);
    await index.query('warmup');

    const wall: number[] = [];
    const top = new Map<string, string>();
    for (let i = 0; i < 20; i++) {
      const q = QUERIES[i % QUERIES.length]!;
      const { hits, latencyMs } = await index.query(q, { k: 3 });
      wall.push(latencyMs);
      if (!top.has(q)) top.set(q, hits.map((h) => h.docId).join(', ') || 'none');
    }
    for (const [q, ids] of top) console.log(`[moss] top3 "${q}" -> ${ids}`);
    const w = [...wall].sort((a, b) => a - b);
    logLatency('moss', 'query p50', pct(w, 50));
    logLatency('moss', 'query p95', pct(w, 95));
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  if (isMossError(err)) console.error(`[moss] error ${err.code} ${err.message}`);
  else console.error(`[moss] error ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
