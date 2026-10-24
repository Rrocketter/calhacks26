// Headless end-to-end check of the /ws server: streams the fixture WAV as a live mic would and
// reports turn events, partial cadence and time-to-first-audio. Start the server first
// (`pnpm --filter @ahead/server dev`). `--twice` sends the WAV a second time on the same socket.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseServerEvent, type ServerEvent } from '@ahead/contracts';
import WebSocket from 'ws';

const FRAME_BYTES = 3200; // 100 ms at 16 kHz s16le mono
const FRAME_MS = 100;
const TURN_TIMEOUT_MS = 20000;
const PORT = Number(process.env.PORT ?? 8787);
const TWICE = process.argv.includes('--twice');

const here = path.dirname(fileURLToPath(import.meta.url));
const wavPath = path.join(here, 'fixtures', 'demo-utterance-1.wav');

// Copied from spike-ink.ts (the spike stays untouched).
function parseWav(buf: Buffer): Buffer {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmtOk = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (channels !== 1 || rate !== 16000 || bits !== 16) {
        throw new Error(`unexpected wav format ch=${channels} rate=${rate} bits=${bits}`);
      }
      fmtOk = true;
    } else if (id === 'data') {
      if (!fmtOk) throw new Error('data chunk before fmt chunk');
      const end = Math.min(body + size, buf.length);
      return buf.subarray(body, size === 0 || size === 0xffffffff ? buf.length : end);
    }
    off = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const pcm = parseWav(readFileSync(wavPath));
const speechFrames = Math.ceil(pcm.length / FRAME_BYTES);
const ZERO = Buffer.alloc(FRAME_BYTES).toString('base64');

interface Round {
  turnIds: Set<string>;
  partials: number[];
  final: string | null;
  turnEndAt: number | null;
  endedTurnId: string | null;
  firstAudioAfterEnd: number | null;
  serverTtfa: number | null;
  audioChunks: number;
  replyAudioMs: number;
  done: boolean;
}
const newRound = (): Round => ({
  turnIds: new Set(),
  partials: [],
  final: null,
  turnEndAt: null,
  endedTurnId: null,
  firstAudioAfterEnd: null,
  serverTtfa: null,
  audioChunks: 0,
  replyAudioMs: 0,
  done: false,
});

const rounds: Round[] = [];
let round = newRound();
let t0 = 0;
const since = () => Math.round(performance.now() - t0);
let seq = 0;
let roundDone: (() => void) | null = null;
let lastTtfa: number | null = null; // sonic sends the metric right before the first chunk
const seenContexts = new Set<string>();

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);

function onEvent(e: ServerEvent): void {
  const now = since();
  let detail = '';
  switch (e.type) {
    case 'turn_start':
      round.turnIds.add(e.turnId);
      detail = ` ${e.turnId}`;
      break;
    case 'transcript_partial':
      round.partials.push(now);
      detail = ` "${e.text}"`;
      break;
    case 'turn_eager_end':
      detail = ` "${e.text}"`;
      break;
    case 'transcript_final':
      round.final = e.text;
      detail = ` "${e.text}"`;
      break;
    case 'turn_end':
      if (round.endedTurnId === null) {
        round.turnEndAt = now;
        round.endedTurnId = e.turnId;
      }
      break;
    case 'tts_audio_chunk': {
      // The round's reply is the audio tagged with the turn that ended (not interjections).
      const isReply = round.endedTurnId !== null && e.turnId === round.endedTurnId;
      if (!e.done) {
        round.audioChunks++;
        if (isReply) {
          if (round.firstAudioAfterEnd === null) {
            round.firstAudioAfterEnd = now;
            round.serverTtfa = lastTtfa;
          }
          round.replyAudioMs += (Buffer.byteLength(e.pcm, 'base64') / 2 / e.sampleRate) * 1000;
        }
      }
      const ctx = e.contextId.slice(0, 8);
      if (e.done) detail = ` done ctx=${ctx} turn=${e.turnId}`;
      else if (seenContexts.has(e.contextId)) return; // print first chunk and done only
      else detail = ` ctx=${ctx} turn=${e.turnId}`;
      seenContexts.add(e.contextId);
      if (e.done && isReply) {
        round.done = true;
        roundDone?.();
      }
      break;
    }
    case 'metric':
      detail = ` ${e.source} ${e.label} ${e.ms.toFixed(1)}ms`;
      if (e.label === 'ttfa') lastTtfa = e.ms;
      break;
    case 'interject':
      detail = ` "${e.text}"`;
      break;
    case 'moss_hits':
      detail = ` "${e.query}"`;
      break;
    case 'error':
      detail = ` ${e.source ?? ''} ${e.message}`;
      break;
  }
  console.log(`${e.type} +${now}ms${detail}`);
}

ws.on('message', (data) => {
  const e = parseServerEvent(data.toString());
  if (!e) {
    console.log('unparseable server event');
    return;
  }
  onEvent(e);
});
ws.on('error', (err) => {
  console.log(`socket error ${err.message}`);
  process.exit(1);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sendFrame(b64: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'audio_chunk', pcm: b64, sampleRate: 16000, seq: seq++ }));
}

// Keep a fixed real-time schedule across the whole run; send speech while `speechLeft > 0`.
let speechOffset = 0;
let speechLeft = 0;
let pumping = true;
async function pump(): Promise<void> {
  const start = performance.now();
  for (let f = 0; pumping; f++) {
    await sleep(Math.max(0, start + f * FRAME_MS - performance.now()));
    if (speechLeft > 0) {
      const frame = Buffer.alloc(FRAME_BYTES);
      pcm.copy(frame, 0, speechOffset, Math.min(speechOffset + FRAME_BYTES, pcm.length));
      speechOffset += FRAME_BYTES;
      speechLeft--;
      sendFrame(frame.toString('base64'));
    } else {
      sendFrame(ZERO);
    }
  }
}

async function runRound(n: number): Promise<void> {
  round = newRound();
  rounds.push(round);
  console.log(`--- round ${n}: sending ${(pcm.length / 32000).toFixed(2)} s of speech ---`);
  speechOffset = 0;
  speechLeft = speechFrames;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.log(`round ${n}: timeout ${TURN_TIMEOUT_MS}ms`);
      resolve();
    }, TURN_TIMEOUT_MS);
    roundDone = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  roundDone = null;
}

function summary(): boolean {
  let ok = true;
  rounds.forEach((r, i) => {
    const gaps = r.partials.slice(1).map((t, j) => t - r.partials[j]!);
    const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    console.log(`--- summary round ${i + 1} ---`);
    console.log(`turn ids: ${[...r.turnIds].join(', ') || 'none'}`);
    console.log(
      `partials: ${r.partials.length}, gap mean ${mean.toFixed(0)}ms, max ${gaps.length ? Math.max(...gaps) : 0}ms`,
    );
    console.log(`final: ${r.final === null ? 'none' : `"${r.final}"`}`);
    const ttfa = r.turnEndAt !== null && r.firstAudioAfterEnd !== null ? r.firstAudioAfterEnd - r.turnEndAt : null;
    console.log(`client ttfa (turn_end -> first tts chunk): ${ttfa === null ? 'none' : `${ttfa}ms`}`);
    console.log(`server metric ttfa: ${r.serverTtfa === null ? 'none' : `${r.serverTtfa.toFixed(1)}ms`}`);
    console.log(`audio chunks: ${r.audioChunks}, reply done: ${r.done}`);
    if (r.final === null || r.audioChunks === 0) ok = false;
  });
  return ok;
}

ws.on('open', () => {
  t0 = performance.now();
  void pump();
  void (async () => {
    await runRound(1);
    if (TWICE) {
      // Wait out the reply's playback plus the server's 300 ms mic tail, like a user would.
      const r = rounds[0]!;
      const playedAt = (r.firstAudioAfterEnd ?? since()) + r.replyAudioMs + 300 + 200;
      await sleep(Math.max(0, playedAt - since()));
      await runRound(2);
    }
    pumping = false;
    ws.close();
    process.exit(summary() ? 0 : 1);
  })();
});
