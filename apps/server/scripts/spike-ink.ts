import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { requireEnv } from '../src/env.js';

const FRAME_BYTES = 3200; // 100 ms at 16 kHz s16le mono
const FRAME_MS = 100;
const SILENCE_MS = 2500;
const END_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 5000;
const CLOSE_GRACE_MS = 3000;

const here = path.dirname(fileURLToPath(import.meta.url));
const wavPath = path.join(here, 'fixtures', 'demo-utterance-1.wav');

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
      // size can be 0 or 0xFFFFFFFF for streamed files; clamp to file end
      const end = Math.min(body + size, buf.length);
      return buf.subarray(body, size === 0 || size === 0xffffffff ? buf.length : end);
    }
    off = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const pcm = parseWav(readFileSync(wavPath));
const apiKey = requireEnv('CARTESIA_API_KEY');
const url =
  'wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14';

const ws = new WebSocket(url, { headers: { 'X-API-Key': apiKey } });

let t0 = 0; // first audio byte
const since = () => (t0 ? Math.round(performance.now() - t0) : 0);
let lastSpeechFrameAt = 0;
let failed = false;
const updateTimes: number[] = [];
const eagerTimes: number[] = [];
const endTimes: number[] = [];
let finalTranscript = '';
let endTimer: NodeJS.Timeout | undefined;
const connectTimer = setTimeout(() => {
  fail(`[ink] error connect timeout ${CONNECT_TIMEOUT_MS}ms`);
  process.exit(1);
}, CONNECT_TIMEOUT_MS);

function fail(msg: string): void {
  console.log(msg);
  failed = true;
}

ws.on('unexpected-response', (_req, res) => {
  fail(`[ink] error http ${res.statusCode} ${res.statusMessage ?? ''}`);
  process.exit(1);
});

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  let msg: { type?: string; transcript?: string; title?: string; message?: string };
  try {
    msg = JSON.parse(data.toString());
  } catch {
    console.log('[ink] unparseable message');
    return;
  }
  const type = msg.type ?? '?';
  const now = since();
  if (type === 'error') {
    fail(`[ink] error ${msg.title} ${msg.message}`);
    report();
    process.exit(1);
  }
  const tr = msg.transcript !== undefined ? ` "${msg.transcript}"` : '';
  console.log(`[ink] ${type} +${now}ms${tr}`);
  if (type === 'turn.update') updateTimes.push(now);
  if (type === 'turn.eager_end') eagerTimes.push(now);
  if (type === 'turn.end') {
    endTimes.push(now);
    finalTranscript = msg.transcript ?? '';
    // server should close after turn.end; do not hang if it does not
    setTimeout(() => {
      console.log('[ink] server did not close within 3s of turn.end');
      report();
      process.exit(failed ? 1 : 0);
    }, CLOSE_GRACE_MS).unref();
  }
});

ws.on('error', (e) => {
  fail(`[ink] error ws ${e.message}`);
});

ws.on('close', (code) => {
  clearTimeout(endTimer);
  console.log(`[ink] closed code=${code}`);
  report();
  process.exit(failed || endTimes.length === 0 ? 1 : 0);
});

function report(): void {
  console.log('--- summary ---');
  const first = updateTimes[0];
  console.log(`first turn.update: ${first === undefined ? 'none' : `+${first}ms`}`);
  const gaps = updateTimes.slice(1).map((t, i) => t - updateTimes[i]!);
  if (gaps.length) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    console.log(
      `updates: ${updateTimes.length}, gap mean ${mean.toFixed(0)}ms, max ${Math.max(...gaps)}ms`,
    );
  } else {
    console.log(`updates: ${updateTimes.length}, no gaps`);
  }
  const lastSpeechMs = Math.round(lastSpeechFrameAt - t0);
  console.log(`last speech frame sent at +${lastSpeechMs}ms`);
  if (endTimes.length) {
    console.log(`turn.end latency after last speech frame: ${endTimes[0]! - lastSpeechMs}ms`);
  } else {
    console.log('turn.end latency: none');
  }
  if (eagerTimes.length && endTimes.length) {
    console.log(`eager_end -> end gap: ${endTimes[0]! - eagerTimes[0]!}ms`);
  } else {
    console.log('eager_end: not seen');
  }
  console.log(`final transcript: "${finalTranscript}"`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stream(): Promise<void> {
  // pace against a fixed schedule so timer drift does not accumulate
  t0 = performance.now();
  let i = 0;
  const speechFrames = Math.ceil(pcm.length / FRAME_BYTES);
  const silenceFrames = SILENCE_MS / FRAME_MS;
  for (let f = 0; f < speechFrames + silenceFrames; f++) {
    const target = t0 + f * FRAME_MS;
    await sleep(Math.max(0, target - performance.now()));
    let frame: Buffer;
    if (f < speechFrames) {
      frame = Buffer.alloc(FRAME_BYTES);
      pcm.copy(frame, 0, i, Math.min(i + FRAME_BYTES, pcm.length));
      i += FRAME_BYTES;
      lastSpeechFrameAt = performance.now();
    } else {
      frame = Buffer.alloc(FRAME_BYTES);
    }
    ws.send(frame);
  }
  ws.send(JSON.stringify({ type: 'close' }));
  endTimer = setTimeout(() => {
    if (endTimes.length === 0) {
      fail('[ink] error timeout no turn.end within 15s of last frame');
      report();
      process.exit(1);
    }
  }, END_TIMEOUT_MS);
}

ws.on('open', () => {
  clearTimeout(connectTimer);
  console.log('[ink] open');
  stream().catch((e: unknown) => {
    fail(`[ink] error stream ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
});
