// Replays an Ink fixture through the live BeliefTracker (real Moss + Haiku) and prints a timeline.
// This is the DEMO_MODE backbone: the only place the Ink fixture drives the live tracker.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MossClient } from '@moss-js/moss';
import { RETRIEVAL_MODES, type Belief, type RetrievalMode, type ServerEvent } from '@ahead/contracts';
import { loadFixture, mockInkStream } from '@ahead/contracts/mocks/node';
import { CONTACTS_FILE, requireEnv } from '../src/env.js';
import { HaikuIntentLlm } from '../src/belief/haiku.js';
import { normalize } from '../src/belief/normalize.js';
import { BeliefTracker } from '../src/belief/tracker.js';
import type { Retriever } from '../src/belief/types.js';
import { ALPHA, MossIndex } from '../src/moss/index.js';
import { SwitchableRetriever } from '../src/moss/cloud-sim.js';
import { generateCorpus } from './gen-corpus.js';

export type ReplayResult = {
  lockAtMs?: number;
  lockPartial?: string;
  interjectAtMs?: number;
  interjectPartial?: string;
  finalBelief: Belief;
};

type Line = (line: string) => void;

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

const fmt = (ms: number) => `+${Math.round(ms)}ms`.padEnd(8);

/** What demo-utterance-1 must lock and say for a PASS. */
/** What a fixture's replay must lock and interject. `said` is the contradicted word. */
export type Expectation = { intent: Belief['intent']; person: string; said: string; interject: string };
export const EXPECTATIONS: Record<string, Expectation> = {
  // Synthetic corpus (unit tests, replay --local-corpus).
  'demo-utterance-1': {
    intent: 'draft_message',
    person: 'Priya Shah',
    said: 'Thursday',
    interject: 'Heads up, the Q3 deck review is Friday at 2, not Thursday. Say Friday?',
  },
  // Imported Google corpus (IMPORT_GOOGLE=1).
  'demo-real-1': {
    intent: 'draft_message',
    person: 'Esha Telang',
    said: 'Tuesday',
    interject: 'Heads up, the VQE meeting is Monday at 8:30, not Tuesday. Say Monday?',
  },
};
export const EXPECTED = EXPECTATIONS['demo-utterance-1']!;

/**
 * Observes the tracker: pass `tap.emit` as the tracker's `emit` (forward to your own sink via
 * `next`) and `tap.wrap(retriever)` as its retriever. The wrapper sees which partial the tracker
 * is processing (its first Moss query is that partial's normalized text), so events can be
 * attributed to the partial that was being processed when they fired.
 */
export class ReplayTap {
  /** Delivered partials in order (raw text, normalized text, wall offset). */
  partials: { text: string; norm: string; atMs: number }[] = [];
  processingIdx = -1;
  /** Wall offsets of eager ends; the tracker never interjects after the user finished. */
  eagerAts: number[] = [];
  t0 = 0;
  turnId = '';
  tracker?: BeliefTracker;
  print: Line = () => {};
  mossMs: number[] = [];
  /** belief.latencyMs.moss of each Moss-driven belief_update (one per changed partial). */
  mossStepMs: number[] = [];
  lock?: { atMs: number; idx: number; belief: Belief };
  interject?: { atMs: number; idx: number; text: string };
  private pendingMoss: { ms: number }[] = [];
  private lastShown = '';
  private lastLlmMs?: number;

  constructor(private readonly next: (ev: ServerEvent) => void = () => {}) {}

  now(): number {
    return performance.now() - this.t0;
  }

  wrap(retriever: Retriever): Retriever {
    return {
      query: (text, opts) => {
        for (let i = this.partials.length - 1; i > this.processingIdx; i--) {
          if (this.partials[i]!.norm === text) {
            this.processingIdx = i;
            break;
          }
        }
        return retriever.query(text, opts);
      },
    };
  }

  emit = (ev: ServerEvent): void => {
    this.next(ev);
    if (ev.type === 'error') {
      // Haiku and tracker error events carry no turnId
      this.print(`${fmt(this.now())} ERROR ${ev.source ?? '?'} ${ev.message}`);
      return;
    }
    if (!this.turnId || !('turnId' in ev) || ev.turnId !== this.turnId) return;
    const t = this.now();
    if (ev.type === 'moss_hits') {
      this.mossMs.push(ev.latencyMs);
      this.pendingMoss.push({ ms: ev.latencyMs });
    } else if (ev.type === 'belief_update') {
      this.onBelief(t, ev.belief);
    } else if (ev.type === 'interject') {
      this.interject = { atMs: t, idx: this.processingIdx, text: ev.text };
      this.print(`${fmt(t)} INTERJECT "${ev.text}"  (processing #${this.processingIdx})`);
    }
  };

  private onBelief(t: number, b: Belief): void {
    if (this.pendingMoss.length) {
      const max = Math.max(...this.pendingMoss.map((m) => m.ms));
      const top = b.topHits.slice(0, 3).map((h) => h.docId).join(', ') || 'none';
      this.mossStepMs.push(b.latencyMs.moss);
      this.print(
        `${fmt(t)} moss     ${this.pendingMoss.length} queries max ${max.toFixed(1)}ms ` +
          `step ${b.latencyMs.moss.toFixed(1)}ms top: ${top}`,
      );
      this.pendingMoss = [];
    }
    const locked = this.tracker?.isLocked(this.turnId) ?? false;
    const justLocked = locked && !this.lock;
    if (justLocked) this.lock = { atMs: t, idx: this.processingIdx, belief: b };
    const llmNew = b.latencyMs.llm !== undefined && b.latencyMs.llm !== this.lastLlmMs;
    this.lastLlmMs = b.latencyMs.llm;
    const ent = Object.entries(b.entities)
      .filter(([k]) => ['person', 'day', 'time', 'file'].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const shown = `${b.intent} ${ent} conf=${b.confidence.toFixed(2)}`;
    if (shown === this.lastShown && !justLocked && !llmNew) return;
    this.lastShown = shown;
    const tags = [
      justLocked ? 'LOCK' : '',
      llmNew ? `(llm ${Math.round(b.latencyMs.llm!)}ms)` : '',
    ].filter(Boolean);
    this.print(`${fmt(t)} belief   ${shown}${tags.length ? ' ' + tags.join(' ') : ''}`);
  }
}

export async function runReplay(opts: {
  fixture: string;
  speed: number;
  tracker: BeliefTracker;
  tap: ReplayTap;
  print: Line;
}): Promise<ReplayResult> {
  const { tracker, tap, print } = opts;
  const fixture = loadFixture(opts.fixture);
  tap.tracker = tracker;
  tap.print = print;
  let finalBelief: Belief | undefined;
  for await (const ev of mockInkStream(fixture, { speed: opts.speed })) {
    if (ev.type === 'turn_start') {
      tap.t0 = performance.now();
      tap.turnId = ev.turnId;
      print(`${fmt(0)} turn_start ${ev.turnId}`);
    } else if (ev.type === 'transcript_partial') {
      const idx = tap.partials.length;
      tap.partials.push({ text: ev.text, norm: normalize(ev.text), atMs: tap.now() });
      print(`${fmt(tap.now())} partial  #${idx} "${ev.text}"`);
      void tracker.onUpdate(ev.turnId, ev.text);
    } else if (ev.type === 'turn_eager_end') {
      print(`${fmt(tap.now())} eager_end`);
      tap.eagerAts.push(tap.now());
      void tracker.onEagerEnd(ev.turnId, ev.text);
    } else if (ev.type === 'turn_resume') {
      print(`${fmt(tap.now())} resume`);
      tracker.onResume(ev.turnId);
    } else if (ev.type === 'transcript_final') {
      print(`${fmt(tap.now())} final    "${ev.text}"`);
      finalBelief = await tracker.onTurnEnd(ev.turnId, ev.text);
      print(
        `${fmt(tap.now())} belief   final ${finalBelief.intent} conf=${finalBelief.confidence.toFixed(2)} ` +
          `entities=${JSON.stringify(finalBelief.entities)}`,
      );
    }
  }
  await tracker.idle();
  const partialText = (i: number) => (i >= 0 ? tap.partials[i]?.text : undefined);
  return {
    lockAtMs: tap.lock?.atMs,
    lockPartial: tap.lock ? partialText(tap.lock.idx) : undefined,
    interjectAtMs: tap.interject?.atMs,
    interjectPartial: tap.interject ? partialText(tap.interject.idx) : undefined,
    finalBelief: finalBelief ?? (tracker.current(fixture.turnId) as Belief),
  };
}

/** Prints the verdict block; returns true on PASS. */
export function printVerdict(tap: ReplayTap, exp: Expectation, print: Line): boolean {
  const said = exp.said;
  const saidIdx = tap.partials.findIndex((p) => p.norm.split(' ').includes(normalize(said)));
  const show = (x?: { atMs: number; idx: number }) =>
    x ? `${fmt(x.atMs).trim()} on #${x.idx} "${tap.partials[x.idx]?.text ?? '?'}"` : 'none';
  print('');
  print('--- verdict ---');
  print(`lock:      ${show(tap.lock)}`);
  print(`interject: ${show(tap.interject)}`);
  print(
    saidIdx >= 0
      ? `${said.toLowerCase()} partial: ${fmt(tap.partials[saidIdx]!.atMs).trim()} #${saidIdx}`
      : `${said.toLowerCase()} partial: none`,
  );
  const ms = [...tap.mossMs].sort((a, b) => a - b);
  print(
    `moss: ${ms.length} queries p50 ${pct(ms, 50).toFixed(1)}ms p95 ${pct(ms, 95).toFixed(1)}ms`,
  );
  const steps = [...tap.mossStepMs].sort((a, b) => a - b);
  print(
    `moss step: ${steps.length} updates p50 ${pct(steps, 50).toFixed(1)}ms p95 ${pct(steps, 95).toFixed(1)}ms`,
  );

  const lockB = tap.lock?.belief;
  print(`locked:    ${lockB ? `${lockB.intent} person=${lockB.entities.person ?? '-'}` : 'none'}`);
  print(`said:      ${tap.interject ? JSON.stringify(tap.interject.text) : 'none'}`);
  const saidAt = saidIdx >= 0 ? tap.partials[saidIdx]!.atMs : NaN;
  if (tap.interject && saidIdx >= 0) print(`interject lag: ${Math.round(tap.interject.atMs - saidAt)}ms after the ${said.toLowerCase()} partial`);
  // Real Ink can deliver the next words a few ms after the contradicted one, so the bar is the
  // user finishing (first eager end after the word), not the next partial.
  const eager = tap.eagerAts.find((t) => t >= saidAt) ?? Infinity;
  const checks: [string, boolean][] = [
    [`${said.toLowerCase()} partial found`, saidIdx >= 0],
    ['lock attributed to an earlier partial', !!tap.lock && tap.lock.idx >= 0 && tap.lock.idx < saidIdx],
    [`lock before the ${said.toLowerCase()} partial arrived`, !!tap.lock && tap.lock.atMs < saidAt],
    [`locked ${exp.intent}`, lockB?.intent === exp.intent],
    [`locked person ${exp.person}`, lockB?.entities.person === exp.person],
    [`interject on the ${said.toLowerCase()} partial`, !!tap.interject && tap.interject.idx === saidIdx],
    ['interject before the user finished (eager end)', !!tap.interject && tap.interject.atMs < eager],
    ['interject text matches', tap.interject?.text === exp.interject],
  ];
  for (const [name, ok] of checks) print(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  const pass = checks.every(([, ok]) => ok);
  print(pass ? 'PASS' : 'FAIL');
  return pass;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixture = args.find((a) => !a.startsWith('--'))?.replace(/^fixture=/, '') ?? 'demo-utterance-1';
  const speedArg = args.find((a) => a.startsWith('--speed='));
  const speed = speedArg ? Number(speedArg.slice('--speed='.length)) : 1;
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`bad --speed: ${speedArg}`);

  const retrievalArg = args.find((a) => a.startsWith('--retrieval='))?.slice('--retrieval='.length) ?? 'moss';
  if (!(RETRIEVAL_MODES as readonly string[]).includes(retrievalArg)) throw new Error(`bad --retrieval: ${retrievalArg}`);
  const localCorpus = args.includes('--local-corpus');

  const { contacts } = JSON.parse(readFileSync(CONTACTS_FILE, 'utf8')) as { contacts: { name: string }[] };

  // Warm-up outside timing, as at server startup.
  const moss = localCorpus ? await loadLocalCorpus() : await MossIndex.load();
  const retriever = new SwitchableRetriever(moss);
  retriever.mode = retrievalArg as RetrievalMode;
  try {
    await moss.query('warmup');
    const llm = new HaikuIntentLlm();
    await llm.classify({ partial: 'warmup', topHits: [] });

    const tap = new ReplayTap();
    const tracker = new BeliefTracker({
      retriever: tap.wrap(retriever),
      llm,
      contacts,
      emit: tap.emit,
      today: () => new Date(),
    });
    const print = (line: string) => console.log(line);
    print(`[replay] fixture=${fixture} speed=${speed} retrieval=${retriever.mode}${localCorpus ? ' corpus=local synthetic' : ''}`);
    await runReplay({ fixture, speed, tracker, tap, print });
    const exp = EXPECTATIONS[fixture];
    if (!exp) {
      print(`no expectation for ${fixture}: timeline only`);
      return;
    }
    const pass = printVerdict(tap, exp, print);
    if (!pass) process.exitCode = 1;
  } finally {
    await moss.close();
  }
}

/**
 * The synthetic corpus (gen-corpus, in memory) in an in-process Moss session index that is never
 * pushed: real Moss retrieval for the demo fixtures now that ahead-corpus holds imported data.
 */
async function loadLocalCorpus(): Promise<Retriever & { close(): Promise<void> }> {
  const client = new MossClient(requireEnv('MOSS_PROJECT_ID'), requireEnv('MOSS_PROJECT_KEY'));
  const t = performance.now();
  const session = await client.session('ahead-replay-local');
  await session.addDocs(generateCorpus().map((d) => ({ id: d.id, text: d.text, metadata: { ...d.metadata } })));
  console.log(`[moss] local synthetic corpus ${session.docCount} docs ${(performance.now() - t).toFixed(0)}ms`);
  return {
    async query(text, opts) {
      if (!text.trim()) return { hits: [], latencyMs: 0 };
      const start = performance.now();
      const res = await session.query(text, { alpha: ALPHA, topK: opts?.k ?? 5 });
      const latencyMs = performance.now() - start;
      const hits = res.docs.map((d) => ({ docId: d.id, score: d.score, snippet: d.text.slice(0, 160), metadata: d.metadata ?? {} }));
      return { hits, latencyMs };
    },
    close: () => client.close(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`[replay] error ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
