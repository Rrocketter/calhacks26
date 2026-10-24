import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT, requireEnv } from '../src/env.js';
import { logLatency } from '../src/log.js';

const MODEL_ID = 'sonic-3.6';
const VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
const CARTESIA_VERSION = '2026-08-14';
const SAMPLE_RATE = 24000;
const TRANSCRIPT =
  'Quick note, your meeting with Priya is Friday at two, not Thursday. Want me to say Friday?';

async function main(): Promise<void> {
  const key = requireEnv('CARTESIA_API_KEY');
  const t0 = performance.now();
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: MODEL_ID,
      transcript: TRANSCRIPT,
      voice: VOICE_ID,
      language: 'en',
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
    }),
  });
  if (!res.ok) {
    console.error(`[sonic] error ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  if (!res.body) throw new Error('no response body');

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let firstByteMs: number | undefined;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === undefined) {
      firstByteMs = performance.now() - t0;
      logLatency('sonic', 'first byte', firstByteMs);
    }
    chunks.push(value);
    bytes += value.length;
  }
  const totalMs = performance.now() - t0;
  logLatency('sonic', 'total', totalMs);

  const outDir = path.join(REPO_ROOT, 'var', 'spikes');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'sonic.wav');
  await writeFile(outFile, Buffer.concat(chunks));
  // 16-bit mono PCM; subtract the 44-byte WAV header.
  const seconds = (bytes - 44) / (SAMPLE_RATE * 2);
  console.log(`[sonic] model=${MODEL_ID} bytes=${bytes} audio=${seconds.toFixed(2)}s -> ${outFile}`);
}

main().catch((err: unknown) => {
  console.error('[sonic] failed', err instanceof Error ? err.message : err);
  process.exit(1);
});
