import { MossClient, type QueryOptions } from '@moss-js/moss';
import { MOSS_INDEX } from '@ahead/contracts';
import { requireEnv } from '../env.js';
import { logLatency } from '../log.js';
import type { RetrievedHit, Retriever } from '../belief/types.js';
import { MemoryStore, mergeHits } from './memory.js';

// Hybrid weight; 0.3 puts contact-priya in the top 3 for "draft a message to priya" (0.5 does not). See docs/sdk-notes.md.
export const ALPHA = 0.3;

export class MossIndex implements Retriever {
  private constructor(
    private readonly client: MossClient,
    /** Conversation memory, queried next to the corpus on every query. Null: corpus only. */
    readonly memory: MemoryStore | null,
  ) {}

  static async load(client?: MossClient, opts: { memory?: boolean } = {}): Promise<MossIndex> {
    const c = client ?? new MossClient(requireEnv('MOSS_PROJECT_ID'), requireEnv('MOSS_PROJECT_KEY'));
    const t = performance.now();
    await c.loadIndex(MOSS_INDEX.corpus);
    logLatency('moss', 'loadIndex', performance.now() - t);
    const memory = opts.memory ? await MemoryStore.open(c) : null;
    return new MossIndex(c, memory);
  }

  async query(
    text: string,
    opts?: { k?: number; filter?: object },
  ): Promise<{ hits: RetrievedHit[]; latencyMs: number }> {
    if (!text.trim()) return { hits: [], latencyMs: 0 };
    const k = opts?.k ?? 5;
    const options = { alpha: ALPHA, topK: k, ...(opts?.filter ? { filter: opts.filter } : {}) };
    const start = performance.now();
    const [res, mem] = await Promise.all([
      this.client.query(MOSS_INDEX.corpus, text, options as QueryOptions),
      this.memory && !opts?.filter ? this.memory.query(text, { alpha: ALPHA }) : null,
    ]);
    const latencyMs = performance.now() - start;
    logLatency('moss', 'query', latencyMs);
    const hits = res.docs.map((d) => ({
      docId: d.id,
      score: d.score,
      snippet: d.text.slice(0, 160),
      metadata: d.metadata ?? {},
    }));
    return { hits: mem ? mergeHits(hits, mem.hits, k) : hits, latencyMs };
  }

  /**
   * Calendar events dated today or later that match `text`. The corpus holds every occurrence of a
   * repeating event, and past ones often outrank the next one, so a lookup adds these first.
   */
  async upcoming(text: string, todayIso: string, k = 3): Promise<RetrievedHit[]> {
    if (!text.trim()) return [];
    const filter = {
      $and: [
        { field: 'type', condition: { $eq: 'calendar' } },
        { field: 'date', condition: { $gte: todayIso } },
      ],
    };
    const start = performance.now();
    const res = await this.client.query(MOSS_INDEX.corpus, text, { alpha: ALPHA, topK: k, filter } as QueryOptions);
    logLatency('moss', 'upcoming', performance.now() - start);
    return res.docs.map((d) => ({ docId: d.id, score: d.score, snippet: d.text.slice(0, 160), metadata: d.metadata ?? {} }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
