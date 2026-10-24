// Spoken-confirm trials: needs a server with DEMO_MODE=1 DEMO_LIVE_INK=1. Each trial plays
// demo-utterance-2 until STAGED asks "Apply?", then streams a recorded "yes" wav through real Ink
// `--delay` ms after the prompt audio ends (estimated like the server's playback clock), with
// silence frames around it like a live mic. Hit = the staged turn COMMITTED within 8 s of the yes.
// Usage: confirm-trials.ts --wav=path/yes.wav [--trials=10] [--delay=400] [--port=8787]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseServerEvent, type ClientEvent } from '@ahead/contracts';
import WebSocket from 'ws';
import { WORKSPACE_DIR } from '../src/env.js';

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const WAV = flag('wav');
const TRIALS = Number(flag('trials') ?? 10);
const DELAY_MS = Number(flag('delay') ?? 400);
const PORT = Number(flag('port') ?? process.env.AHEAD_SERVER_PORT ?? 8787);
const FRAME_BYTES = 3200; // 100 ms at 16 kHz s16le mono
const FRAME_MS = 100;
const HIT_WITHIN_MS = 8000;
if (!WAV) {
  console.log('usage: confirm-trials.ts --wav=yes.wav [--trials=10] [--delay=400] [--port=8787]');
  process.exit(1);
}

function parseWav(buf: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const ch = buf.readUInt16LE(off + 10);
      const rate = buf.readUInt32LE(off + 12);
      const bits = buf.readUInt16LE(off + 22);
      if (ch !== 1 || rate !== 16000 || bits !== 16) throw new Error(`need 16 kHz mono s16 wav, got ${ch}/${rate}/${bits}`);
    } else if (id === 'data') {
      return buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const yesPcm = parseWav(readFileSync(WAV));
const yesFrames: string[] = [];
for (let i = 0; i < yesPcm.length; i += FRAME_BYTES) {
  const f = Buffer.alloc(FRAME_BYTES);
  yesPcm.copy(f, 0, i, Math.min(i + FRAME_BYTES, yesPcm.length));
  yesFrames.push(f.toString('base64'));
}
const ZERO = Buffer.alloc(FRAME_BYTES).toString('base64');
const git = (...args: string[]) => execFileSync('git', ['-C', WORKSPACE_DIR, ...args], { encoding: 'utf8' }).trim();
const base = git('rev-parse', 'main');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Trial = {
  hit: boolean;
  note: string;
  firstPartialMs: number | null; // after the yes started
  firstPartial: string | null;
  endNoUpdate: boolean;
  final: string | null;
};

function trial(n: number): Promise<Trial> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const send = (e: ClientEvent) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(e));
    const queue: string[] = [];
    let seq = 0;
    let stagedTurn: string | null = null;
    let stagedAt = 0;
    const tts = new Map<string, { first: number; samples: number; rate: number }>();
    let yesAt = 0;
    let yesTurn: string | null = null;
    const partialTurns = new Set<string>();
    const out: Trial = { hit: false, note: '', firstPartialMs: null, firstPartial: null, endNoUpdate: false, final: null };
    let done = false;
    const finish = (note: string) => {
      if (done) return;
      done = true;
      out.note = note;
      clearInterval(mic);
      clearTimeout(guard);
      // Let the commit merge land before the next trial resets main.
      setTimeout(() => {
        ws.close();
        resolve(out);
      }, out.hit ? 4000 : 500);
    };
    const guard = setTimeout(() => finish(stagedTurn ? 'timeout after STAGED' : 'never STAGED'), 90_000);
    const mic = setInterval(() => {
      send({ type: 'audio_chunk', pcm: queue.shift() ?? ZERO, sampleRate: 16000, seq: seq++ });
    }, FRAME_MS);

    ws.on('open', () => send({ type: 'demo_control', action: 'start', fixture: 'demo-utterance-2' }));
    ws.on('message', (raw) => {
      const ev = parseServerEvent(raw.toString());
      if (!ev) return;
      const now = Date.now();
      if (ev.type === 'state_change' && ev.state === 'STAGED' && !stagedTurn) {
        stagedTurn = ev.turnId;
        stagedAt = now;
      } else if (ev.type === 'state_change' && ev.turnId === stagedTurn && yesAt) {
        if (ev.state === 'COMMITTED') {
          out.hit = now - yesAt <= HIT_WITHIN_MS;
          finish(`COMMITTED +${now - yesAt}ms after yes start`);
        } else if (ev.state === 'ROLLED_BACK') finish('ROLLED_BACK');
      } else if (ev.type === 'tts_audio_chunk' && stagedTurn && now >= stagedAt && !yesAt) {
        const t = tts.get(ev.contextId) ?? { first: now, samples: 0, rate: ev.sampleRate };
        t.samples += Buffer.byteLength(ev.pcm, 'base64') / 2;
        tts.set(ev.contextId, t);
        if (ev.done) {
          const promptEnd = t.first + (t.samples / t.rate) * 1000;
          const wait = Math.max(0, promptEnd + DELAY_MS - now);
          setTimeout(() => {
            yesAt = Date.now();
            queue.push(...yesFrames);
            setTimeout(() => finish(`no commit within ${HIT_WITHIN_MS}ms`), HIT_WITHIN_MS + 500);
          }, wait);
        }
      } else if (ev.type === 'turn_start' && yesAt && !yesTurn) {
        yesTurn = ev.turnId;
      } else if (ev.type === 'transcript_partial' && yesAt && ev.text.trim()) {
        partialTurns.add(ev.turnId);
        if (out.firstPartial === null) {
          out.firstPartial = ev.text;
          out.firstPartialMs = now - yesAt;
        }
      } else if (ev.type === 'transcript_final' && yesAt && ev.text.trim()) {
        out.final = ev.text;
      } else if (ev.type === 'turn_end' && yesAt && !partialTurns.has(ev.turnId) && ev.turnId === yesTurn) {
        out.endNoUpdate = true;
      }
    });
    ws.on('error', (err) => finish(`ws error ${err.message}`));
    void n;
  });
}

const results: Trial[] = [];
for (let i = 1; i <= TRIALS; i++) {
  const r = await trial(i);
  results.push(r);
  const partial = r.firstPartial === null ? 'no partial' : `first partial +${r.firstPartialMs}ms "${r.firstPartial}"`;
  console.log(
    `trial ${i}: ${r.hit ? 'HIT ' : 'MISS'} ${r.note}; ${partial}; final=${JSON.stringify(r.final)}${r.endNoUpdate ? '; turn.end with no update' : ''}`,
  );
  git('reset', '--hard', base);
  await sleep(1500);
}
const hits = results.filter((r) => r.hit).length;
console.log(`--- ${hits}/${TRIALS} hits (delay ${DELAY_MS} ms after prompt audio end) ---`);
