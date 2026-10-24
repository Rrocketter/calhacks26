import type { Belief, MossHit, ServerEvent } from '@ahead/contracts';
import { logLatency } from '../log.js';
import { BELIEF_CONFIG, type BeliefConfig } from './config.js';
import { extractToDay, makeEntityExtractor, resolveDay, type FastEntities } from './entities.js';
import { lastWords, normalize } from './normalize.js';
import type { IntentLlm, IntentResult, RetrievedHit, Retriever } from './types.js';

type Deps = {
  retriever: Retriever;
  llm: IntentLlm;
  contacts: { name: string }[];
  emit: (ev: ServerEvent) => void;
  config?: Partial<BeliefConfig>;
  today?: () => Date;
};

type TurnState = {
  rawText: string;
  normText: string;
  changedUpdates: number;
  fast: FastEntities;
  acc: Map<string, { acc: number; hit: RetrievedHit }>;
  topHits: RetrievedHit[];
  mossSupport: number;
  mossMs: number;
  llmResult?: IntentResult;
  llmMs?: number;
  llmInFlight: boolean;
  llmPending: boolean;
  llmEntitiesAtLastCall: FastEntities;
  nextSeq: number;
  lastAppliedSeq: number;
  belief?: Belief;
  locked: boolean;
  finalized: boolean;
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function toMossHit(h: RetrievedHit): MossHit {
  return { docId: h.docId, score: h.score, snippet: h.snippet };
}

export class BeliefTracker {
  private readonly cfg: BeliefConfig;
  private readonly extract: (normalizedText: string) => FastEntities;
  private readonly today: () => Date;
  private readonly turns = new Map<string, TurnState>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: Deps) {
    this.cfg = { ...BELIEF_CONFIG, ...deps.config };
    this.extract = makeEntityExtractor(deps.contacts);
    this.today = deps.today ?? (() => new Date());
  }

  current(turnId: string): Belief | undefined {
    return this.turns.get(turnId)?.belief;
  }

  isLocked(turnId: string): boolean {
    return this.turns.get(turnId)?.locked ?? false;
  }

  isFinalized(turnId: string): boolean {
    return this.turns.get(turnId)?.finalized ?? false;
  }

  /** Resolves when no LLM call is in flight (including queued follow-up calls). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async onUpdate(turnId: string, text: string): Promise<void> {
    let st = this.turns.get(turnId);
    if (!st) {
      st = {
        rawText: '',
        normText: '',
        changedUpdates: 0,
        fast: {},
        acc: new Map(),
        topHits: [],
        mossSupport: 0,
        mossMs: 0,
        llmInFlight: false,
        llmPending: false,
        llmEntitiesAtLastCall: {},
        nextSeq: 1,
        lastAppliedSeq: 0,
        locked: false,
        finalized: false,
      };
      this.turns.set(turnId, st);
    }
    const norm = normalize(text);
    if (norm === st.normText) return;
    st.rawText = text;
    st.normText = norm;
    st.changedUpdates++;
    const fast = this.extract(norm);
    st.fast = fast;

    // 1. Moss queries
    const queries = this.buildQueries(norm, fast);
    const results = await Promise.all(
      queries.map(async (q) => ({ q, ...(await this.deps.retriever.query(q)) })),
    );
    let mossMs = 0;
    for (const r of results) {
      logLatency('moss', 'query', r.latencyMs);
      mossMs = Math.max(mossMs, r.latencyMs);
      this.deps.emit({
        type: 'moss_hits',
        turnId,
        query: r.q,
        hits: r.hits.map(toMossHit),
        latencyMs: r.latencyMs,
      });
      this.deps.emit({ type: 'metric', source: 'moss', label: 'query', ms: r.latencyMs });
    }
    st.mossMs = mossMs;

    // 2. Accumulator with recency decay
    for (const entry of st.acc.values()) entry.acc *= this.cfg.RECENCY_DECAY;
    for (const r of results) {
      r.hits.forEach((h, rank) => {
        const entry = st.acc.get(h.docId);
        const w = 1 / (rank + 1);
        if (entry) {
          entry.acc += w;
          entry.hit = h;
        } else {
          st.acc.set(h.docId, { acc: w, hit: h });
        }
      });
    }
    st.topHits = [...st.acc.values()]
      .sort((a, b) => b.acc - a.acc)
      .slice(0, this.cfg.TOP_HITS)
      .map((e) => e.hit);
    st.mossSupport = this.mossSupport(fast, st.topHits);

    this.rebuild(turnId, st);

    // 3. LLM trigger
    const everyN = st.changedUpdates % this.cfg.LLM_EVERY_N_UPDATES === 0;
    const newEntity = (Object.keys(fast) as (keyof FastEntities)[]).some(
      (k) => fast[k] !== st.llmEntitiesAtLastCall[k],
    );
    if (everyN || newEntity) {
      if (st.llmInFlight) st.llmPending = true;
      else this.startLlm(turnId, st);
    }
  }

  private buildQueries(norm: string, fast: FastEntities): string[] {
    const qs = [norm];
    const tail = lastWords(norm, 6);
    if (tail !== norm) qs.push(tail);
    const person = fast.person ? normalize(fast.person) : undefined;
    if (person) qs.push(person);
    if (fast.day) qs.push(person ? `${person} ${fast.day}` : fast.day);
    if (fast.file) qs.push(fast.file);
    return [...new Set(qs.filter(Boolean))];
  }

  private mossSupport(fast: FastEntities, topHits: RetrievedHit[]): number {
    let total = 0;
    let resolved = 0;
    if (fast.person) {
      total++;
      const name = fast.person.toLowerCase();
      if (topHits.some((h) => (h.metadata.people ?? '').toLowerCase().includes(name))) resolved++;
    }
    if (fast.file) {
      total++;
      const words = fast.file;
      if (
        topHits.some(
          (h) =>
            h.metadata.type === 'file' &&
            normalize(`${h.metadata.title ?? ''} ${h.snippet}`).includes(words),
        )
      )
        resolved++;
    }
    return total === 0 ? 0 : resolved / total;
  }

  private startLlm(turnId: string, st: TurnState): void {
    const seq = st.nextSeq++;
    st.llmInFlight = true;
    st.llmPending = false;
    st.llmEntitiesAtLastCall = { ...st.fast };
    const p = this.deps.llm
      .classify({ partial: st.rawText, topHits: st.topHits.map(toMossHit) })
      .then(
        ({ result, latencyMs }) => {
          if (this.turns.get(turnId) !== st) return;
          if (seq < st.lastAppliedSeq) return; // stale
          st.lastAppliedSeq = seq;
          st.llmResult = result;
          st.llmMs = latencyMs;
          this.rebuild(turnId, st);
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`[llm] error ${message}`);
          this.deps.emit({ type: 'error', source: 'llm', message });
        },
      )
      .finally(() => {
        this.inFlight.delete(p);
        st.llmInFlight = false;
        if (st.llmPending && this.turns.get(turnId) === st) this.startLlm(turnId, st);
      });
    this.inFlight.add(p);
  }

  private normalizePerson(name: string): string {
    const n = normalize(name);
    const c = this.deps.contacts.find((c) => {
      const full = normalize(c.name);
      return full === n || full.split(' ')[0] === n;
    });
    return c ? c.name : name;
  }

  private rebuild(turnId: string, st: TurnState): void {
    const llm = st.llmResult;
    const entities: Record<string, string> = {};
    for (const [k, v] of Object.entries(st.fast)) if (v !== undefined) entities[k] = v;
    if (llm) for (const [k, v] of Object.entries(llm.entities)) entities[k] = String(v);
    if (entities.person) entities.person = this.normalizePerson(entities.person);

    const today = this.today();
    const day = st.fast.day ?? (entities.day ? normalize(entities.day) : undefined);
    if (day) {
      try {
        Object.assign(entities, resolveDay(day, today));
      } catch {
        // LLM gave a day we cannot resolve; leave weekday/date_iso unset
      }
    }
    const toDay = extractToDay(st.normText);
    if (toDay && toDay !== st.fast.day) {
      const r = resolveDay(toDay, today);
      entities.to_weekday = r.weekday;
      entities.to_date_iso = r.date_iso;
    }

    const intent = llm?.intent ?? 'unknown';
    const confidence =
      intent !== 'unknown'
        ? clamp01(this.cfg.W_LLM * clamp01(llm?.confidence ?? 0) + this.cfg.W_MOSS * st.mossSupport)
        : clamp01(Math.min(0.5, this.cfg.W_MOSS * st.mossSupport));

    const belief: Belief = {
      intent,
      entities,
      claims: llm?.claims ?? [],
      confidence,
      topHits: st.topHits.map(toMossHit),
      latencyMs: st.llmMs === undefined ? { moss: st.mossMs } : { moss: st.mossMs, llm: st.llmMs },
    };
    st.belief = belief;

    if (!st.locked && intent !== 'unknown' && confidence >= this.cfg.SPECULATE_AT) {
      st.locked = true;
      console.log(
        `[belief] lock ${intent} ${entities.person ?? '-'} conf=${confidence.toFixed(2)}`,
      );
    }
    this.deps.emit({ type: 'belief_update', turnId, belief });
  }
}
