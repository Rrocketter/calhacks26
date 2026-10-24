import type { Belief, Claim, MossHit, ServerEvent } from '@ahead/contracts';
import { logLatency } from '../log.js';
import { BELIEF_CONFIG, INTERJECT_TEMPLATE, type BeliefConfig } from './config.js';
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
  llmInFlight: number;
  llmPending: boolean;
  llmEntitiesAtLastCall: FastEntities;
  nextSeq: number;
  lastAppliedSeq: number;
  belief?: Belief;
  locked: boolean;
  finalized: boolean;
  /** Bumped by onResume so a pending onEagerEnd does not finalize after a resume. */
  resumeGen: number;
  /** Set once onTurnEnd starts: no more streaming llm calls or follow-ups for this turn. */
  ending: boolean;
  interjectClaim?: Claim;
  chain: Promise<void>;
};

/** Strong hit: the doc's rank in the accumulator topHits. */
const STRONG_HIT_RANK = 3;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Whole-word containment on normalized text. */
function containsWords(haystack: string, needle: string): boolean {
  return needle !== '' && ` ${haystack} `.includes(` ${needle} `);
}

/** Leading hour of a normalized time ("2 pm" -> "2"). */
function hourOf(time: string): string {
  return /^\d{1,2}/.exec(normalize(time))?.[0] ?? normalize(time);
}

function sameValue(field: string, a: string, b: string): boolean {
  return field === 'time' ? hourOf(a) === hourOf(b) : normalize(a) === normalize(b);
}

function unknownBelief(): Belief {
  return {
    intent: 'unknown',
    entities: {},
    claims: [],
    confidence: 0,
    topHits: [],
    latencyMs: { moss: 0 },
  };
}

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

  /**
   * Queue an update for the turn. Updates for one turn run strictly in order, so callers
   * need not await. The returned promise settles when this update is done and never rejects.
   */
  onUpdate(turnId: string, text: string): Promise<void> {
    const st = this.getOrCreate(turnId);
    const step = st.chain.then(() => this.doUpdate(turnId, st, text));
    st.chain = step.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[moss] error ${message}`);
      this.deps.emit({ type: 'error', source: 'moss', message });
    });
    return st.chain;
  }

  /**
   * Process the eager-end text, then mark the turn finalized. Does not wait for in-flight llm
   * calls: their results still update the belief (never interject while finalized), and the
   * turn-end seq bump drops any that land after onTurnEnd starts.
   */
  onEagerEnd(turnId: string, text: string): Promise<void> {
    const st = this.getOrCreate(turnId);
    const gen = st.resumeGen;
    void this.onUpdate(turnId, text);
    const step = st.chain.then(() => {
      if (this.isEnded(turnId, st)) return;
      if (st.resumeGen === gen && this.turns.get(turnId) === st) st.finalized = true;
    });
    st.chain = step;
    return step;
  }

  /** The user kept talking: clear finalized only (re-enables interject). Unknown turns are ignored. */
  onResume(turnId: string): void {
    const st = this.turns.get(turnId);
    if (!st) return;
    st.resumeGen++;
    st.finalized = false;
  }

  /**
   * One final llm call over the final text, queued behind pending updates. Its seq is newer
   * than any streaming call, so a late streaming result is dropped. Deletes the turn state.
   */
  onTurnEnd(turnId: string, finalText: string): Promise<Belief> {
    const st = this.turns.get(turnId);
    if (!st) return Promise.resolve(unknownBelief());
    const step = st.chain.then(() => this.doTurnEnd(turnId, st, finalText));
    st.chain = step.then(
      () => undefined,
      () => undefined,
    );
    return step;
  }

  private async doTurnEnd(turnId: string, st: TurnState, finalText: string): Promise<Belief> {
    if (this.isEnded(turnId, st)) return st.belief ?? unknownBelief(); // duplicate turn end
    st.ending = true;
    st.llmPending = false;
    const seq = st.nextSeq++;
    const norm = normalize(finalText);
    if (norm !== st.normText) {
      st.rawText = finalText;
      st.normText = norm;
      st.fast = this.extract(norm);
    }
    try {
      const { result, latencyMs } = await this.deps.llm.classify({
        partial: finalText,
        topHits: st.topHits.map(toMossHit),
        final: true,
      });
      logLatency('llm', 'final', latencyMs);
      st.lastAppliedSeq = Math.max(st.lastAppliedSeq, seq);
      st.llmResult = result;
      st.llmMs = latencyMs;
      this.rebuild(turnId, st);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[llm] error ${message}`);
      this.deps.emit({ type: 'error', source: 'llm', message });
    } finally {
      if (this.turns.get(turnId) === st) this.turns.delete(turnId);
    }
    return st.belief ?? unknownBelief();
  }

  private getOrCreate(turnId: string): TurnState {
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
        llmInFlight: 0,
        llmPending: false,
        llmEntitiesAtLastCall: {},
        nextSeq: 1,
        lastAppliedSeq: 0,
        locked: false,
        finalized: false,
        resumeGen: 0,
        ending: false,
        chain: Promise.resolve(),
      };
      this.turns.set(turnId, st);
    }
    return st;
  }

  /** True once onTurnEnd has started for this state, or the state was replaced/deleted. */
  private isEnded(turnId: string, st: TurnState): boolean {
    return st.ending || this.turns.get(turnId) !== st;
  }

  private async doUpdate(turnId: string, st: TurnState, text: string): Promise<void> {
    if (this.isEnded(turnId, st)) return;
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

    // 3. LLM trigger: first changed partial, every Nth, or a new entity. Up to
    // MAX_LLM_IN_FLIGHT calls run at once; the seq guard drops out-of-order results.
    const first = st.changedUpdates === 1;
    const everyN = st.changedUpdates % this.cfg.LLM_EVERY_N_UPDATES === 0;
    const newEntity = (Object.keys(fast) as (keyof FastEntities)[]).some(
      (k) => fast[k] !== st.llmEntitiesAtLastCall[k],
    );
    if ((first || everyN || newEntity) && !st.ending) {
      if (st.llmInFlight >= this.cfg.MAX_LLM_IN_FLIGHT) st.llmPending = true;
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
    st.llmInFlight++;
    st.llmPending = false;
    st.llmEntitiesAtLastCall = { ...st.fast };
    const p = this.deps.llm
      .classify({ partial: st.rawText, topHits: st.topHits.map(toMossHit) })
      .then(
        ({ result, latencyMs }) => {
          if (seq < st.lastAppliedSeq) {
            console.log(`[llm] stale seq=${seq} dropped`);
            return;
          }
          if (this.turns.get(turnId) !== st) return;
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
        st.llmInFlight--;
        if (st.llmPending && !st.ending && this.turns.get(turnId) === st) {
          this.startLlm(turnId, st);
        }
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
    // Fast day/time are already normalized; the llm sometimes returns prose ("Thursday at 2").
    if (llm) {
      for (const [k, v] of Object.entries(llm.entities)) {
        if ((k === 'day' || k === 'time') && st.fast[k] !== undefined) continue;
        entities[k] = String(v);
      }
    }
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

    const claims = [...(llm?.claims ?? [])];
    const fired = st.interjectClaim;
    if (fired && !claims.some((c) => c.docId === fired.docId && c.field === fired.field)) {
      claims.push(fired);
    }
    const belief: Belief = {
      intent,
      entities,
      claims,
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
    const interject = this.checkContradiction(st, belief);
    this.deps.emit({ type: 'belief_update', turnId, belief });
    if (interject) this.deps.emit({ type: 'interject', turnId, text: interject });
  }

  /** Fast-path claim: person + day (or time when no day) vs a strong calendar hit for that person. */
  private fastClaim(st: TurnState): Claim | undefined {
    const { person, day, time } = st.fast;
    if (!person || (!day && !time)) return undefined;
    const name = person.toLowerCase();
    const doc = st.topHits
      .slice(0, STRONG_HIT_RANK)
      .find(
        (h) =>
          h.metadata.type === 'calendar' &&
          (h.metadata.people ?? '').toLowerCase().includes(name),
      );
    if (!doc) return undefined;
    const field = day ? 'day' : 'time';
    const said = (day ?? time)!;
    const known = doc.metadata[field];
    if (!known || sameValue(field, said, known)) return undefined;
    return {
      field,
      said: capitalize(said),
      known: field === 'day' ? capitalize(normalize(known)) : known,
      docId: doc.docId,
    };
  }

  /**
   * Picks the first verified candidate (llm claims, then the fast path). On a hit, records the
   * claim on the belief and returns the interject text. Max one per turn.
   */
  private checkContradiction(st: TurnState, belief: Belief): string | undefined {
    // never interject after the user stopped (finalized by eager end, or turn end)
    if (st.interjectClaim || st.ending || st.finalized) return undefined;
    if (!st.locked || belief.confidence < this.cfg.INTERJECT_AT) return undefined;
    const fast = this.fastClaim(st);
    const candidates = [...belief.claims, ...(fast ? [fast] : [])];
    for (const c of candidates) {
      const rank = st.topHits.findIndex((h) => h.docId === c.docId);
      if (rank < 0 || rank >= STRONG_HIT_RANK) continue;
      const doc = st.topHits[rank]!;
      const said = normalize(c.said);
      const known = normalize(c.known);
      if (!said || !known || sameValue(c.field, c.said, c.known)) continue;
      const docText = normalize(`${doc.snippet} ${Object.values(doc.metadata).join(' ')}`);
      if (!containsWords(docText, known)) continue;
      if (!containsWords(st.normText, said)) continue;
      if (belief.intent === 'reschedule_event' && said === belief.entities.to_weekday) continue;

      const person = belief.entities.person ?? (doc.metadata.people ?? '').split(',')[0] ?? '';
      const first = person.trim().split(/\s+/)[0] ?? '';
      const text = INTERJECT_TEMPLATE.replace('{person}', first)
        .replaceAll('{known}', capitalize(c.known.trim()))
        .replace('{said}', capitalize(c.said.trim()));
      st.interjectClaim = c;
      if (!belief.claims.some((x) => x === c)) belief.claims.push(c);
      console.log(`[belief] interject ${c.field} said=${c.said} known=${c.known} doc=${c.docId}`);
      return text;
    }
    return undefined;
  }
}
