import type { MossClient, QueryOptions, SearchResult } from '@moss-js/moss';
import { MEMORY_DOC_PREFIX, MOSS_INDEX, type Belief } from '@ahead/contracts';
import { logLatency } from '../log.js';
import type { RetrievedHit } from '../belief/types.js';

export type Outcome = 'committed' | 'rolled back' | 'lookup' | 'staged' | 'no action';
export type MemoryDoc = { id: string; text: string; metadata: Record<string, string> };

/** Where the orchestrator writes memory. Fire-and-forget: never on the reply path. */
export interface MemoryPort {
  add(doc: MemoryDoc): Promise<void>;
}

/** The part of Moss's SessionIndex the store uses. */
export interface MemorySession {
  addDocs(docs: MemoryDoc[], options?: { upsert?: boolean }): Promise<{ added: number; updated: number }>;
  query(query: string, options?: QueryOptions): Promise<SearchResult>;
  /** Creates the cloud index. Replacing an existing one fails on the free plan's 3-index cap. */
  pushIndex(): Promise<unknown>;
}

/** Cloud upsert into the existing `ahead-memory` index (MossClient.addDocs; polls until rebuilt). */
export type CloudAdd = (docs: MemoryDoc[]) => Promise<unknown>;

/** Memory hits merged into each corpus query, after the corpus top MEMORY_RANK. */
export const MEMORY_K = 2;
/** Corpus hits that keep their rank: the interject's strong-hit ranks never hold a memory doc. */
export const MEMORY_RANK = 3;
/** Memory scores run higher than the corpus's (small index), so only gate out weak matches. */
export const MEMORY_MIN_SCORE = 0.3;
/** Memory snippets are longer than corpus ones so a lookup answer sees the committed text. */
const MEMORY_SNIPPET = 400;

/**
 * Conversation memory in a Moss SessionIndex: upserts land in process in milliseconds and queries
 * see them at once. Off the hot path each write is persisted to the cloud index `ahead-memory`:
 * pushIndex creates it the first time, cloud addDocs (upsert) after that. Loaded back at startup.
 */
export class MemoryStore implements MemoryPort {
  /** Docs written since the last successful persist, by id (an upsert replaces its older version). */
  private readonly pending = new Map<string, MemoryDoc>();
  private persisting: Promise<void> | null = null;

  constructor(
    private readonly session: MemorySession,
    private readonly cloudAdd: CloudAdd,
    /** Whether `ahead-memory` exists in the cloud. */
    private inCloud: boolean,
  ) {}

  static async open(client: MossClient): Promise<MemoryStore> {
    let t = performance.now();
    const session = await client.session(MOSS_INDEX.memory);
    logLatency('moss', 'memory session', performance.now() - t);
    const inCloud = await client.getIndex(MOSS_INDEX.memory).then(
      () => true,
      () => false,
    );
    t = performance.now();
    let n = 0;
    if (inCloud) {
      try {
        n = await session.loadIndex(MOSS_INDEX.memory);
      } catch (err) {
        console.error(`[moss] memory loadIndex failed, starting empty: ${String(err).slice(0, 160)}`);
      }
    }
    logLatency('moss', `memory loadIndex (${n} docs)`, performance.now() - t);
    const cloudAdd: CloudAdd = (docs) => client.addDocs(MOSS_INDEX.memory, docs, { upsert: true });
    return new MemoryStore(session, cloudAdd, inCloud);
  }

  async add(doc: MemoryDoc): Promise<void> {
    const t = performance.now();
    await this.session.addDocs([doc], { upsert: true });
    logLatency('moss', `memory add ${doc.id}`, performance.now() - t);
    this.pending.set(doc.id, doc);
    this.persisting ??= this.persistLoop();
  }

  async query(text: string, opts: { alpha: number }): Promise<{ hits: RetrievedHit[]; latencyMs: number }> {
    const start = performance.now();
    const res = await this.session.query(text, { alpha: opts.alpha, topK: MEMORY_K, minScore: MEMORY_MIN_SCORE });
    const latencyMs = performance.now() - start;
    logLatency('moss', 'memory query', latencyMs);
    const hits = res.docs.map((d) => ({
      docId: d.id,
      score: d.score,
      snippet: d.text.slice(0, MEMORY_SNIPPET),
      metadata: d.metadata ?? {},
    }));
    return { hits, latencyMs };
  }

  /** Resolves once no persist is running. */
  async flushed(): Promise<void> {
    while (this.persisting) await this.persisting;
  }

  /**
   * One persist at a time; writes made during one coalesce into the next. A failed batch stays
   * pending (unless a newer version replaced it) and is retried on the next write.
   */
  private async persistLoop(): Promise<void> {
    while (this.pending.size > 0) {
      const docs = [...this.pending.values()];
      this.pending.clear();
      const t = performance.now();
      try {
        if (this.inCloud) {
          await this.cloudAdd(docs);
          logLatency('moss', `memory cloud addDocs (${docs.length} docs)`, performance.now() - t);
        } else {
          await this.session.pushIndex();
          this.inCloud = true;
          logLatency('moss', 'memory pushIndex', performance.now() - t);
        }
      } catch (err) {
        console.error(`[moss] memory persist failed, will retry on the next write: ${String(err).slice(0, 160)}`);
        for (const d of docs) if (!this.pending.has(d.id)) this.pending.set(d.id, d);
        break;
      }
    }
    this.persisting = null;
  }
}

/** Corpus order kept for the top MEMORY_RANK, then memory hits, then the rest of the corpus, capped at k. */
export function mergeHits(corpus: RetrievedHit[], memory: RetrievedHit[], k: number): RetrievedHit[] {
  return [...corpus.slice(0, MEMORY_RANK), ...memory.slice(0, MEMORY_K), ...corpus.slice(MEMORY_RANK)].slice(0, k);
}

export function isMemoryHit(docId: string): boolean {
  return docId.startsWith(MEMORY_DOC_PREFIX);
}

export function beliefSummary(b: Belief | undefined): string {
  if (!b) return 'unknown';
  const entities = Object.entries(b.entities)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);
  return [b.intent, ...entities].join(' ');
}

/** What the user said in one turn, what we understood, and how it ended. Upserted when the outcome changes. */
export function turnMemoryDoc(i: { turnId: string; date: string; text: string; belief?: Belief; outcome: Outcome }): MemoryDoc {
  return {
    id: `${MEMORY_DOC_PREFIX}${i.turnId}`,
    text: `User said: "${i.text.trim()}" Understood: ${beliefSummary(i.belief)}. Outcome: ${i.outcome}.`,
    metadata: { type: 'memory', date: i.date, people: i.belief?.entities.person ?? '', outcome: i.outcome },
  };
}

/** The content a committed turn wrote: the draft text or the calendar change. Null without a diff. */
export function artifactMemoryDoc(i: {
  turnId: string;
  date: string;
  belief?: Belief;
  diffs: { file: string; diff: string }[];
}): MemoryDoc | null {
  const parts = i.diffs.flatMap(({ file, diff }) => {
    const added = changedLines(diff, '+');
    const removed = changedLines(diff, '-');
    if (added.length === 0 && removed.length === 0) return [];
    if (removed.length === 0) return [`${file}: ${added.join(' ')}`];
    return [`${file}: changed ${removed.join(' ')} to ${added.join(' ')}`];
  });
  if (parts.length === 0) return null;
  const person = i.belief?.entities.person;
  const lead =
    i.belief?.intent === 'draft_message' && person
      ? `Told ${person} in a message`
      : `Committed ${i.belief?.intent ?? 'change'}${person ? ` for ${person}` : ''}`;
  return {
    id: `${MEMORY_DOC_PREFIX}${i.turnId}-artifact`,
    text: `${lead} on ${i.date}. ${parts.join(' ')}`,
    metadata: { type: 'memory', date: i.date, people: person ?? '', outcome: 'committed' },
  };
}

/** Added ('+') or removed ('-') lines of a unified diff, without headers, trimmed, blanks dropped. */
function changedLines(diff: string, sign: '+' | '-'): string[] {
  const header = sign === '+' ? '+++' : '---';
  return diff
    .split('\n')
    .filter((l) => l.startsWith(sign) && !l.startsWith(header))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);
}
