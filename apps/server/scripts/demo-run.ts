// Headless DEMO_MODE driver: asks the running server (DEMO_MODE=1) to play a fixture through the
// live belief tracker and Droid executor, answers the correction and Apply prompts, then checks the
// workspace. Usage: demo-run.ts [fixture] [--confirm=client|spoken|reject] [--port=N] [--no-correct]
import { execFileSync } from 'node:child_process';
import { parseServerEvent, type ClientEvent, type ServerEvent } from '@ahead/contracts';
import WebSocket from 'ws';
import { WORKSPACE_DIR } from '../src/env.js';

const DONE_TIMEOUT_MS = 90000;
const TTS_WAIT_MS = 15000;

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const fixture = args.find((a) => !a.startsWith('--')) ?? 'demo-utterance-1';
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
const CORRECTION_WINDOW_MS = 8000;
let turnEndAt = 0;
const changed: string[] = [];
let correctionAfter: number | null = null; // earliest time the correction may be answered

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const send = (e: ClientEvent) => ws.send(JSON.stringify(e));
const fixtureTtsOpen = () => [...openCtx.values()].some((t) => t === fixtureTurn);

let finish: (() => void) | null = null;
const finished = new Promise<void>((r) => (finish = r));

function answerCorrection(): void {
  corrected = true;
  if (since() > turnEndAt + CORRECTION_WINDOW_MS) {
    correctionExpired = true;
    console.log('WARN: correction window (8000 ms after turn_end) already passed; not answering, treating as not accepted');
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
      if (e.turnId === fixtureTurn) {
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
      detail = ` ${e.kind}${e.denied ? ' denied' : ''}`;
      break;
    case 'tts_audio_chunk': {
      const ctx = e.contextId.slice(0, 8);
      if (e.done) {
        openCtx.delete(e.contextId);
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
      detail = ` ${e.source} ${e.label} ${e.ms.toFixed(1)}ms`;
      break;
    case 'moss_hits':
      detail = ` "${e.query}"`;
      break;
    case 'error':
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
  send({ type: 'demo_control', action: 'start', fixture });
  const timer = setTimeout(() => {
    console.log(`timeout ${DONE_TIMEOUT_MS}ms waiting for COMMITTED/ROLLED_BACK`);
    finish?.();
  }, DONE_TIMEOUT_MS);
  const poll = setInterval(tick, 200);
  await finished;
  clearTimeout(timer);
  clearInterval(poll);
  ws.close();

  const problems: string[] = [];
  let priya = '';
  try {
    const subject = git('log', '-1', '--format=%s', 'main').trim();
    changed.push(...git('diff-tree', '--no-commit-id', '--name-only', '-r', 'main').split('\n').filter(Boolean));
    console.log(`--- workspace main: ${subject} ---\n${git('show', 'main', '--stat')}`);
    if (finalState === 'COMMITTED') priya = git('show', 'main:messages/outbox/priya.md');
  } catch (err) {
    problems.push(`workspace git failed: ${(err as Error).message.split('\n')[0]}`);
  }

  console.log('--- summary ---');
  console.log(`turn_start -> lock: ${gap('turn_start', 'lock')}`);
  console.log(`turn_start -> interject: ${gap('turn_start', 'interject')}`);
  console.log(`turn_start -> first droid_event: ${gap('turn_start', 'droid')}`);
  console.log(`turn_start -> STAGED: ${gap('turn_start', 'staged')}`);
  console.log(`STAGED -> final: ${gap('staged', 'final')}`);
  console.log(`events: ${[...counts].map(([k, v]) => `${k}=${v}`).join(' ')}`);

  const utt1 = fixture.includes('utterance-1');
  const utt2 = fixture.includes('utterance-2');
  const want = confirm === 'reject' ? 'ROLLED_BACK' : 'COMMITTED';
  if (marks.lock === undefined) problems.push('no state_change SPECULATING');
  if (marks.droid === undefined) problems.push('no droid_event');
  if (!stagedSeen) problems.push('no STAGED');
  if (finalState !== want) problems.push(`final state ${finalState ?? 'none'}, wanted ${want}`);
  if (utt1 && !interjected) problems.push('no interject for utterance 1');
  if (finalState === 'COMMITTED' && want === 'COMMITTED') {
    const file = utt1 ? 'messages/outbox/priya.md' : utt2 ? 'calendar.json' : null;
    if (file && !changed.includes(file)) problems.push(`main diff does not touch ${file}`);
    if (utt1 && interjected && !NO_CORRECT) {
      if (correctionExpired) problems.push('correction window expired before the driver answered');
      if (!priya.includes('Friday')) problems.push('priya.md lacks Friday');
      if (priya.includes('Thursday')) problems.push('priya.md still has Thursday');
    }
  }
  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('PASS');
  process.exit(0);
});
