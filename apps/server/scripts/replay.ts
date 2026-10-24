// Replays an Ink fixture through the live BeliefTracker (real Moss + Haiku) and prints a timeline.
// This is the DEMO_MODE backbone: the only place the Ink fixture drives the live tracker.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Belief, ServerEvent } from '@ahead/contracts';
import { loadFixture, mockInkStream } from '@ahead/contracts/mocks/node';
import { REPO_ROOT } from '../src/env.js';
import { HaikuIntentLlm } from '../src/belief/haiku.js';
import { normalize } from '../src/belief/normalize.js';
import { BeliefTracker } from '../src/belief/tracker.js';
import type { Retriever } from '../src/belief/types.js';
import { MossIndex } from '../src/moss/index.js';

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
export const EXPECTED = {
  intent: 'draft_message',
  person: 'Priya Shah',
  interject: 'Say Friday?',
} as const;

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
export function printVerdict(tap: ReplayTap, said: string, print: Line): boolean {
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
  const nextAt = saidIdx >= 0 ? (tap.partials[saidIdx + 1]?.atMs ?? Infinity) : NaN;
  const checks: [string, boolean][] = [
    [`${said.toLowerCase()} partial found`, saidIdx >= 0],
    ['lock attributed to an earlier partial', !!tap.lock && tap.lock.idx >= 0 && tap.lock.idx < saidIdx],
    [`lock before the ${said.toLowerCase()} partial arrived`, !!tap.lock && tap.lock.atMs < saidAt],
    [`locked ${EXPECTED.intent}`, lockB?.intent === EXPECTED.intent],
    [`locked person ${EXPECTED.person}`, lockB?.entities.person === EXPECTED.person],
    [`interject on the ${said.toLowerCase()} partial`, !!tap.interject && tap.interject.idx === saidIdx],
    ['interject before the next partial arrived', !!tap.interject && tap.interject.atMs < nextAt],
    ['interject text matches', tap.interject?.text === EXPECTED.interject],
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

  const contactsFile = path.join(REPO_ROOT, 'workspace-seed', 'contacts.json');
  const { contacts } = JSON.parse(readFileSync(contactsFile, 'utf8')) as { contacts: { name: string }[] };

  // Warm-up outside timing, as at server startup.
  const moss = await MossIndex.load();
  try {
    await moss.query('warmup');
    const llm = new HaikuIntentLlm();
    await llm.classify({ partial: 'warmup', topHits: [] });

    const tap = new ReplayTap();
    const tracker = new BeliefTracker({
      retriever: tap.wrap(moss),
      llm,
      contacts,
      emit: tap.emit,
      today: () => new Date(),
    });
    const print = (line: string) => console.log(line);
    print(`[replay] fixture=${fixture} speed=${speed}`);
    await runReplay({ fixture, speed, tracker, tap, print });
    const pass = printVerdict(tap, 'Thursday', print);
    if (!pass) process.exitCode = 1;
  } finally {
    await moss.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`[replay] error ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
