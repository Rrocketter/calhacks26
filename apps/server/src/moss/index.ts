import { MossClient, type QueryOptions } from '@moss-js/moss';
import { MOSS_INDEX } from '@ahead/contracts';
import { requireEnv } from '../env.js';
import { logLatency } from '../log.js';
import type { RetrievedHit, Retriever } from '../belief/types.js';

// Hybrid weight; 0.3 puts contact-priya in the top 3 for "draft a message to priya" (0.5 does not). See docs/sdk-notes.md.
const ALPHA = 0.3;

export class MossIndex implements Retriever {
  private constructor(private readonly client: MossClient) {}

  static async load(client?: MossClient): Promise<MossIndex> {
    const c = client ?? new MossClient(requireEnv('MOSS_PROJECT_ID'), requireEnv('MOSS_PROJECT_KEY'));
    const t = performance.now();
    await c.loadIndex(MOSS_INDEX.corpus);
    logLatency('moss', 'loadIndex', performance.now() - t);
    return new MossIndex(c);
  }

  async query(
    text: string,
    opts?: { k?: number; filter?: object },
  ): Promise<{ hits: RetrievedHit[]; latencyMs: number }> {
    if (!text.trim()) return { hits: [], latencyMs: 0 };
    const options = { alpha: ALPHA, topK: opts?.k ?? 5, ...(opts?.filter ? { filter: opts.filter } : {}) };
    const start = performance.now();
    const res = await this.client.query(MOSS_INDEX.corpus, text, options as QueryOptions);
    const latencyMs = performance.now() - start;
    logLatency('moss', 'query', latencyMs);
    const hits = res.docs.map((d) => ({
      docId: d.id,
      score: d.score,
      snippet: d.text.slice(0, 160),
      metadata: d.metadata ?? {},
    }));
    return { hits, latencyMs };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
