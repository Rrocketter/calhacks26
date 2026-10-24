import type { ServerEvent } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type TimedPartial = { atMs: number; text: string; final?: boolean };
export type InkFixture = { turnId: string; partials: TimedPartial[] };

export function loadFixture(name: string): InkFixture {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as InkFixture;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* mockInkStream(
  fixture: InkFixture,
  opts: { speed?: number } = {},
): AsyncGenerator<ServerEvent> {
  const speed = opts.speed ?? 1;
  const { turnId } = fixture;
  yield { type: 'turn_start', turnId, ts: Date.now() };
  let prev = 0;
  let last = '';
  for (const p of fixture.partials) {
    await sleep(Math.max(0, (p.atMs - prev) / speed));
    prev = p.atMs;
    last = p.text;
    yield { type: 'transcript_partial', turnId, text: p.text, ts: Date.now() };
  }
  yield { type: 'transcript_final', turnId, text: last, ts: Date.now() };
  yield { type: 'turn_end', turnId, ts: Date.now() };
}
