import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerEvent } from '@ahead/contracts';
import { DEMO_INTERJECTION } from '@ahead/contracts/mocks';
import { REPO_ROOT, requireEnv } from '../src/env.js';
import { SonicClient } from '../src/voice/sonic-client.js';
import { TURN_END_REPLY } from '../src/voice/session.js';

const events: ServerEvent[] = [];
let waiter: ((ctx: string) => void) | null = null;
const client = new SonicClient({
  apiKey: requireEnv('CARTESIA_API_KEY'),
  send: (e) => {
    events.push(e);
    if (e.type === 'tts_audio_chunk' && e.done) waiter?.(e.contextId);
  },
});

function ttfa(): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'metric' && e.label === 'ttfa') return e.ms;
  }
  return NaN;
}

function bytesFor(ctx: string): Buffer {
  const parts = events.flatMap((e) =>
    e.type === 'tts_audio_chunk' && e.contextId === ctx && !e.done ? [Buffer.from(e.pcm, 'base64')] : [],
  );
  return Buffer.concat(parts);
}

async function run(text: string): Promise<{ ms: number; pcm: Buffer }> {
  const done = new Promise<string>((resolve, reject) => {
    waiter = resolve;
    setTimeout(() => reject(new Error('timeout waiting for done')), 15000);
  });
  const ctx = client.speak(text, { interrupt: false, turnId: 't' });
  await done;
  return { ms: ttfa(), pcm: bytesFor(ctx) };
}

async function main(): Promise<void> {
  const coldStart = performance.now();
  const cold = await run(TURN_END_REPLY); // opens the socket inside speak()
  console.log(`cold (connect + speak) first chunk ${cold.ms.toFixed(1)}ms, wall ${(performance.now() - coldStart).toFixed(0)}ms`);

  await client.connect();
  const warm: number[] = [];
  let last: Buffer = Buffer.alloc(0);
  let totalBytes = 0;
  for (const [name, text] of [['demo', DEMO_INTERJECTION], ['turn-end', TURN_END_REPLY]] as const) {
    for (let i = 1; i <= 3; i++) {
      const r = await run(text);
      warm.push(r.ms);
      totalBytes += r.pcm.length;
      last = r.pcm;
      console.log(`warm ${name} #${i}: first chunk ${r.ms.toFixed(1)}ms, ${r.pcm.length} bytes, ${(r.pcm.length / 48000).toFixed(2)}s`);
    }
  }
  const sorted = [...warm].sort((a, b) => a - b);
  console.log(`warm p50 ${((sorted[2]! + sorted[3]!) / 2).toFixed(1)}ms min ${sorted[0]!.toFixed(1)}ms max ${sorted[5]!.toFixed(1)}ms; total ${totalBytes} bytes (${(totalBytes / 48000).toFixed(2)}s)`);

  // Cancel test
  const before = events.length;
  const droppedBefore = client.droppedChunks;
  const ctx = client.speak(DEMO_INTERJECTION, { interrupt: false, turnId: 'c' });
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      if (events.slice(before).some((e) => e.type === 'tts_audio_chunk' && e.contextId === ctx)) {
        clearInterval(iv);
        resolve();
      }
    }, 2);
  });
  const t0 = performance.now();
  client.cancelActive();
  const forwardedAtCancel = events.slice(before).filter((e) => e.type === 'tts_audio_chunk' && e.contextId === ctx).length;
  await new Promise((r) => setTimeout(r, 3000));
  const forwardedTotal = events.slice(before).filter((e) => e.type === 'tts_audio_chunk' && e.contextId === ctx).length;
  console.log(
    `cancel: forwarded before ${forwardedAtCancel}, forwarded after ${forwardedTotal - forwardedAtCancel}, dropped by client ${client.droppedChunks - droppedBefore} (observed ${(performance.now() - t0).toFixed(0)}ms window)`,
  );

  const outDir = path.join(REPO_ROOT, 'var', 'spikes');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'sonic-ws.raw');
  await writeFile(outFile, last);
  console.log(`wrote ${outFile} (${last.length} bytes)`);
  client.close();
}

main().catch((err: unknown) => {
  console.error('[sonic] failed', err instanceof Error ? err.message : err);
  client.close();
  process.exit(1);
});
