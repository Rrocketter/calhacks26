// Headless DEMO_MODE driver: asks the running server (DEMO_MODE=1) to play a fixture through the
// live belief tracker and Droid executor, answers the correction and Apply prompts, then checks the
// workspace against CHECKS. Lookup fixtures wait for the spoken answer and check the final belief.
// Usage: demo-run.ts [fixture] [--confirm=client|spoken|reject] [--port=N] [--no-correct]
// demo-real-* need the server and this driver on the Google import (IMPORT_GOOGLE=1).
import { execFileSync } from 'node:child_process';
import { parseServerEvent, type Belief, type ClientEvent, type ServerEvent } from '@ahead/contracts';
import WebSocket from 'ws';
import { WORKSPACE_DIR } from '../src/env.js';
import { CORRECTION_TIMEOUT_MS } from '../src/orchestrator.js';

const DONE_TIMEOUT_MS = 90000;
const TTS_WAIT_MS = 15000;

/**
 * Per fixture. action: the committed file must / must not match after a commit, `staged` must match
 * the file's staged diff, and an interject is required when `interject`. lookup: the final belief is
 * a lookup whose Moss hits (docId + snippet) match `hit`.
 */
type Check =
  | { kind: 'action'; file: string; interject?: boolean; must?: RegExp[]; mustNot?: RegExp[]; staged?: RegExp[] }
  | { kind: 'lookup'; hit: RegExp };
const CHECKS: Record<string, Check> = {
  // Synthetic seed (unit-test fixtures).
  'demo-utterance-1': { kind: 'action', file: 'messages/outbox/priya.md', interject: true, must: [/Friday/], mustNot: [/Thursday/] },
  'demo-utterance-2': { kind: 'action', file: 'calendar.json' },
  // Google import (IMPORT_GOOGLE=1). Dates are for the week of 2026-10-24.
  'demo-real-1': { kind: 'action', file: 'messages/outbox/esha.md', interject: true, must: [/Monday/], mustNot: [/Tuesday/] },
  'demo-real-2': {
    kind: 'action',
    file: 'calendar.json',
    staged: [/^-.*"start": "2026-10-27T13:00:00-07:00"/m, /^\+.*"start": "2026-10-28T14:00:00-07:00"/m],
  },
  'demo-real-3': { kind: 'lookup', hit: /MATH 52 HW due/i },
  'demo-real-4': { kind: 'lookup', hit: /^memory-\S+-artifact .*\besha\b/i },
};

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const fixture = args.find((a) => !a.startsWith('--')) ?? 'demo-real-1';
const check = CHECKS[fixture];
const LOOKUP = check?.kind === 'lookup';
const confirm = flag('confirm') ?? 'spoken';
const PORT = Number(flag('port') ?? process.env.AHEAD_SERVER_PORT ?? 8787);
const NO_CORRECT = args.includes('--no-correct');
if (!['client', 'spoken', 'reject'].includes(confirm)) {
  console.log(`bad --confirm=${confirm} (client|spoken|reject)`);
  process.exit(1);
}

const t0 = performance.now();
const since = () => Math.round(performance.now() - t0);
const counts = new Map<string, number>();
const marks: Record<string, number> = {};
const mark = (k: string, now: number) => {
  if (marks[k] === undefined) marks[k] = now;
};

let fixtureTurn: string | null = null;
let turnEnded = false;
let interjected = false;
let corrected = false; // correction answered
let stagedSeen = false;
let stagedAt = 0; // ms; the Apply answer waits for TTS done after this
let applyAnswered = false;
let finalState: string | null = null;
const openCtx = new Map<string, string>(); // contextId -> turnId
const seenContexts = new Set<string>();
let stagedCtx: string | null = null; // first fixture-turn TTS context opened after STAGED
let stagedLineDone = false;
let correctionExpired = false; // server's correction window closed before we could answer
const CORRECTION_WINDOW_MS = CORRECTION_TIMEOUT_MS;
let turnEndAt = 0;
let lastBelief: Belief | null = null;
let speculated = false; // the fixture turn reached SPECULATING (a lookup's find_file guess)
let rolledBack = false;
const stagedDiffs = new Map<string, string>();
const changed: string[] = [];
let correctionAfter: number | null = null; // earliest time the correction may be answered

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const send = (e: ClientEvent) => ws.send(JSON.stringify(e));
const fixtureTtsOpen = () => [...openCtx.values()].some((t) => t === fixtureTurn);

let mergeDone: (() => void) | null = null;
const merged = new Promise<void>((r) => (mergeDone = r));
let mergeError: string | null = null;
let finish: (() => void) | null = null;
const finished = new Promise<void>((r) => (finish = r));

function answerCorrection(): void {
  corrected = true;
  if (since() > turnEndAt + CORRECTION_WINDOW_MS) {
    correctionExpired = true;
    console.log(`WARN: correction window (${CORRECTION_WINDOW_MS} ms after turn_end) already passed; not answering, treating as not accepted`);
    return;
  }
  const yes = !NO_CORRECT;
  console.log(`> answering correction: ${yes ? 'yes' : 'no'} (${confirm})`);
  if (confirm === 'spoken') send({ type: 'demo_control', action: 'start', fixture: yes ? 'demo-yes' : 'demo-no' });
  else send({ type: 'confirm_action', turnId: fixtureTurn!, apply: yes });
}

function answerApply(): void {
  applyAnswered = true;
  console.log(`> answering Apply?: ${confirm}`);
  if (confirm === 'client') send({ type: 'confirm_action', turnId: fixtureTurn!, apply: true });
  else send({ type: 'demo_control', action: 'start', fixture: confirm === 'spoken' ? 'demo-yes' : 'demo-no' });
}

// Called on every event and on a short timer.
function tick(): void {
  if (fixtureTurn === null) return;
  const now = since();
  if (interjected && turnEnded && !corrected && !fixtureTtsOpen() && (correctionAfter === null || now >= correctionAfter)) {
    answerCorrection();
  }
  if (stagedSeen && !applyAnswered && (stagedLineDone || now - stagedAt > TTS_WAIT_MS)) {
    // Do not race the correction answer: it must go first.
    if (!interjected || corrected) answerApply();
  }
}

function onEvent(e: ServerEvent): void {
  const now = since();
  counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  let detail = '';
  switch (e.type) {
    case 'turn_start':
      if (fixtureTurn === null) {
        fixtureTurn = e.turnId;
        mark('turn_start', now);
      }
      detail = ` ${e.turnId}`;
      break;
    case 'transcript_partial':
    case 'transcript_final':
    case 'turn_eager_end':
      detail = ` "${e.text}"`;
      break;
    case 'belief_update':
      if (e.turnId === fixtureTurn) lastBelief = e.belief;
      break;
    case 'turn_end':
      if (e.turnId === fixtureTurn) {
        turnEnded = true;
        mark('turn_end', now);
        // Give the interject/reply speech a moment to open its TTS context.
        correctionAfter = now + 500;
        turnEndAt = now;
        setTimeout(tick, 550);
      }
      break;
    case 'state_change':
      detail = ` ${e.state} turn=${e.turnId}`;
      if (e.turnId === fixtureTurn && LOOKUP) {
        if (e.state === 'SPECULATING') speculated = true;
        if (e.state === 'ROLLED_BACK') rolledBack = true;
      } else if (e.turnId === fixtureTurn) {
        if (e.state === 'SPECULATING') mark('lock', now);
        if (e.state === 'STAGED' && !stagedSeen) {
          stagedSeen = true;
          stagedAt = now;
          mark('staged', now);
        }
        if (e.state === 'COMMITTED' || e.state === 'ROLLED_BACK') {
          finalState = e.state;
          mark('final', now);
          finish?.();
        }
      }
      break;
    case 'interject':
      detail = ` "${e.text}"`;
      if (!interjected) {
        interjected = true;
        mark('interject', now);
      }
      break;
    case 'droid_event':
      mark('droid', now);
      if (e.kind === 'diff' && e.turnId === fixtureTurn) {
        const p = e.payload as { file?: string; diff?: string };
        if (p.file && p.diff) stagedDiffs.set(p.file, p.diff);
      }
      detail = ` ${e.kind}${e.denied ? ' denied' : ''}`;
      break;
    case 'tts_audio_chunk': {
      const ctx = e.contextId.slice(0, 8);
      if (e.done) {
        openCtx.delete(e.contextId);
        if (LOOKUP && turnEnded && e.turnId === fixtureTurn) {
          mark('answer', now);
          setTimeout(() => finish?.(), 1500); // let the final belief land
        }
        if (e.contextId === stagedCtx) stagedLineDone = true;
        detail = ` done ctx=${ctx} turn=${e.turnId}`;
      } else {
        openCtx.set(e.contextId, e.turnId);
        if (stagedSeen && stagedCtx === null && e.turnId === fixtureTurn && !seenContexts.has(e.contextId)) stagedCtx = e.contextId;
        if (seenContexts.has(e.contextId)) return;
        detail = ` ctx=${ctx} turn=${e.turnId}`;
      }
      seenContexts.add(e.contextId);
      break;
    }
    case 'metric':
      if (e.source === 'droid' && finalState !== null && e.label === (finalState === 'COMMITTED' ? 'commit' : 'rollback')) {
        mark('merge', now);
        mergeDone?.();
      }
      detail = ` ${e.source} ${e.label} ${e.ms.toFixed(1)}ms`;
      break;
    case 'moss_hits':
      detail = ` "${e.query}"`;
      break;
    case 'error':
      if (e.source === 'droid' && finalState !== null) {
        mergeError = e.message;
        mergeDone?.();
      }
      detail = ` ${e.source ?? ''} ${e.message}`;
      break;
  }
  console.log(`${e.type} +${now}ms${detail}`);
  tick();
}

ws.on('message', (data) => {
  const e = parseServerEvent(data.toString());
  if (!e) return console.log('unparseable server event');
  onEvent(e);
});
ws.on('error', (err) => {
  console.log(`cannot reach ws://localhost:${PORT}/ws (${err.message || err.name || 'connection failed'}). Start the server with DEMO_MODE=1 first.`);
  process.exit(1);
});
ws.on('close', () => finish?.());

const git = (...a: string[]) => execFileSync('git', ['-C', WORKSPACE_DIR, ...a], { encoding: 'utf8' });
const gap = (a: string, b: string) =>
  marks[a] !== undefined && marks[b] !== undefined ? `${marks[b]! - marks[a]!}ms` : 'n/a';

ws.on('open', async () => {
  console.log(`--- demo-run fixture=${fixture} confirm=${confirm}${NO_CORRECT ? ' no-correct' : ''} workspace=${WORKSPACE_DIR} ---`);
  const startMain = git('rev-parse', 'main').trim();
  send({ type: 'demo_control', action: 'start', fixture });
  const timer = setTimeout(() => {
    console.log(`timeout ${DONE_TIMEOUT_MS}ms waiting for COMMITTED/ROLLED_BACK`);
    finish?.();
  }, DONE_TIMEOUT_MS);
  const poll = setInterval(tick, 200);
  await finished;
  if (finalState !== null) {
    const t = setTimeout(() => {
      console.log('timeout 15000ms waiting for the droid commit/rollback metric');
      mergeDone?.();
    }, 15000);
    await merged;
    clearTimeout(t);
  }
  clearTimeout(timer);
  clearInterval(poll);
  ws.close();

  const problems: string[] = [];
  const action = check?.kind === 'action' ? check : null;
  let content = '';
  try {
    const mainSubject = git('log', '-1', '--format=%s', 'main').trim();
    changed.push(...git('diff-tree', '--no-commit-id', '--name-only', '-r', 'main').split('\n').filter(Boolean));
    console.log(`--- workspace main: ${mainSubject} ---\n${git('show', 'main', '--stat')}`);
    if (finalState === 'COMMITTED' && action) content = git('show', `main:${action.file}`);
  } catch (err) {
    problems.push(`workspace git failed: ${(err as Error).message.split('\n')[0]}`);
  }

  console.log('--- summary ---');
  console.log(`turn_start -> lock: ${gap('turn_start', 'lock')}`);
  console.log(`turn_start -> interject: ${gap('turn_start', 'interject')}`);
  console.log(`turn_start -> first droid_event: ${gap('turn_start', 'droid')}`);
  console.log(`turn_start -> STAGED: ${gap('turn_start', 'staged')}`);
  console.log(`STAGED -> final: ${gap('staged', 'final')}`);
  console.log(`${finalState === 'ROLLED_BACK' ? 'rollback' : 'commit'} done ${marks.merge === undefined ? 'n/a' : `+${marks.merge}ms (STAGED -> merge-done ${gap('staged', 'merge')})`}`);
  console.log(`turn_end -> spoken answer: ${gap('turn_end', 'answer')}`);
  console.log(`events: ${[...counts].map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (!check) problems.push(`no CHECKS entry for ${fixture}`);
  if (check?.kind === 'lookup') {
    const b = lastBelief as Belief | null;
    const hits = (b?.topHits ?? []).map((h) => `${h.docId} ${h.snippet}`);
    console.log(`final belief: ${b?.intent ?? 'none'} conf=${b?.confidence ?? '-'}; speculated=${speculated} rolled_back=${rolledBack}`);
    for (const h of hits) console.log(`  hit ${h.slice(0, 140)}`);
    if (b?.intent !== 'lookup') problems.push(`final intent ${b?.intent ?? 'none'}, wanted lookup`);
    if (!hits.some((h) => check.hit.test(h))) problems.push(`no hit matching ${check.hit}`);
    if (marks.answer === undefined) problems.push('no spoken answer');
    if (speculated && !rolledBack) problems.push('a speculation started and was not rolled back');
  }
  if (action) {
    const want = confirm === 'reject' ? 'ROLLED_BACK' : 'COMMITTED';
    if (marks.lock === undefined) problems.push('no state_change SPECULATING');
    if (marks.droid === undefined) problems.push('no droid_event');
    if (!stagedSeen) problems.push('no STAGED');
    if (mergeError !== null) problems.push(`droid error after final state: ${mergeError}`);
    else if (marks.merge === undefined) problems.push('no droid commit/rollback metric');
    if (finalState !== want) problems.push(`final state ${finalState ?? 'none'}, wanted ${want}`);
    if (action.interject && !interjected) problems.push(`no interject for ${fixture}`);
    const staged = stagedDiffs.get(action.file) ?? '';
    const changedLines = staged.split('\n').filter((l) => /^[-+](?![-+])/.test(l));
    console.log(`staged ${action.file}: ${changedLines.length} changed lines`);
    for (const l of changedLines.slice(0, 8)) console.log(`  ${l.slice(0, 160)}`);
    for (const re of action.staged ?? []) if (!re.test(staged)) problems.push(`staged ${action.file} diff lacks ${re}`);
    if (finalState === 'ROLLED_BACK' && want === 'ROLLED_BACK') {
      const dirty = git('status', '--porcelain').trim();
      const moved = git('rev-parse', 'main').trim() !== startMain;
      if (moved || dirty) problems.push(`main not clean after discard (${moved ? 'main moved' : 'main unchanged'}, ${dirty ? 'dirty' : 'clean'})`);
    }
    if (finalState === 'COMMITTED' && want === 'COMMITTED') {
      if (!changed.includes(action.file)) problems.push(`main diff does not touch ${action.file}`);
      if (action.interject && interjected && !NO_CORRECT) {
        if (correctionExpired) problems.push('correction window expired before the driver answered');
        for (const re of action.must ?? []) if (!re.test(content)) problems.push(`${action.file} lacks ${re}`);
        for (const re of action.mustNot ?? []) if (re.test(content)) problems.push(`${action.file} still matches ${re}`);
      }
    }
  }
  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('PASS');
  process.exit(0);
});
