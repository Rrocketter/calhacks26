// Records an Ink fixture the Lane 0 way: macOS `say` makes a 16 kHz mono WAV of the sentence
// (kept in scripts/fixtures/<name>.wav), which streams in real time through real Ink 2 with silence
// around it like a live mic. Every Ink turn.update / eager_end / resume / end is written, with its
// time from Ink's turn.start, to packages/contracts/mocks/fixtures/<name>.json.
// Usage: record-fixture.ts <name> "<sentence>" [--voice=Samantha] [--rate=180]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InkFixture, TimedPartial } from '@ahead/contracts/mocks';
import { requireEnv } from '../src/env.js';
import { InkClient } from '../src/voice/ink-client.js';
import type { InkMessage } from '../src/voice/turns.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const [name, sentence] = args.filter((a) => !a.startsWith('--'));
if (!name || !sentence) {
  console.log('usage: record-fixture.ts <name> "<sentence>" [--voice=Samantha] [--rate=180]');
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const wavPath = path.join(here, 'fixtures', `${name}.wav`);
const outPath = path.resolve(here, '../../../packages/contracts/mocks/fixtures', `${name}.json`);
const FRAME_BYTES = 3200; // 100 ms at 16 kHz s16le mono
const FRAME_MS = 100;
const LEAD_MS = 500;
const TAIL_LIMIT_MS = 15000;

execFileSync('say', ['-v', flag('voice') ?? 'Samantha', '-r', flag('rate') ?? '180', '-o', wavPath, '--data-format=LEI16@16000', sentence]);

function pcmOf(buf: Buffer): Buffer {
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
      return buf.subarray(off + 8, size === 0 || size === 0xffffffff ? buf.length : Math.min(off + 8 + size, buf.length));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const pcm = pcmOf(fs.readFileSync(wavPath));
const frames: Buffer[] = [];
for (let i = 0; i < LEAD_MS / FRAME_MS; i++) frames.push(Buffer.alloc(FRAME_BYTES));
for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
  const f = Buffer.alloc(FRAME_BYTES);
  pcm.copy(f, 0, i, Math.min(i + FRAME_BYTES, pcm.length));
  frames.push(f);
}
const speechMs = Math.round((pcm.length / 2 / 16000) * 1000);

const partials: TimedPartial[] = [];
let startAt: number | null = null;
let ended = false;
const at = () => Math.round(performance.now() - (startAt ?? performance.now()));
const done = new Promise<void>((resolve) => {
  const ink = new InkClient({
    apiKey: requireEnv('CARTESIA_API_KEY'),
    onError: (m) => console.log(`[ink] error ${m}`),
    onMessage: (m: InkMessage) => {
      if (ended) return;
      if (m.type === 'turn.start' && startAt === null) startAt = performance.now();
      if (startAt === null) return;
      const text = (m.transcript ?? '').trim();
      if (m.type === 'turn.update' && text) partials.push({ atMs: at(), text });
      else if (m.type === 'turn.eager_end') partials.push({ atMs: at(), text, eager: true });
      else if (m.type === 'turn.resume') partials.push({ atMs: at(), text: '', resume: true });
      else if (m.type === 'turn.end') {
        partials.push({ atMs: at(), text, final: true });
        ended = true;
        ink.close();
        resolve();
      }
    },
  });
  void ink.connect().then(() => {
    const t0 = performance.now();
    let i = 0;
    const timer = setInterval(() => {
      if (ended || performance.now() - t0 > speechMs + LEAD_MS + TAIL_LIMIT_MS) {
        clearInterval(timer);
        if (!ended) {
          ink.close();
          resolve();
        }
        return;
      }
      ink.sendPcm(frames[i++] ?? Buffer.alloc(FRAME_BYTES));
    }, FRAME_MS);
  });
});
await done;

if (!partials.some((p) => p.final)) {
  console.log(`no turn.end within ${TAIL_LIMIT_MS}ms after speech; not writing ${outPath}`);
  process.exit(1);
}
const fixture: InkFixture = { turnId: name, partials };
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
const final = partials.find((p) => p.final)!;
console.log(`[record] ${name}: speech ${speechMs}ms, ${partials.length} events, final +${final.atMs}ms "${final.text}"`);
for (const p of partials) console.log(`  +${p.atMs}ms ${p.final ? 'end   ' : p.eager ? 'eager ' : p.resume ? 'resume' : 'update'} ${p.text}`);
