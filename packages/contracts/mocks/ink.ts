import type { ServerEvent } from '../src/index.js';

/**
 * One Ink 2 message, timed from turn_start. Each entry maps to exactly one Ink event:
 * - default: `turn.update` → `transcript_partial` (text is cumulative, like Ink)
 * - `eager: true`: `turn.eager_end` → `turn_eager_end` with this text (finalize trigger)
 * - `resume: true`: `turn.resume` → `turn_resume` (text ignored; same turn continues)
 * - `final: true`: `turn.end` → `transcript_final` with this text, then `turn_end`. Later entries are ignored.
 * If no entry is final, the stream ends after the last entry with the last text seen.
 */
export type TimedPartial = { atMs: number; text: string; final?: boolean; eager?: boolean; resume?: boolean };
export type InkFixture = { turnId: string; partials: TimedPartial[] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Browser-safe: pass the fixture object (Node callers can use loadFixture from `@ahead/contracts/mocks/node`). */
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
    if (p.final) {
      last = p.text;
      break;
    }
    if (p.eager) {
      yield { type: 'turn_eager_end', turnId, text: p.text, ts: Date.now() };
    } else if (p.resume) {
      yield { type: 'turn_resume', turnId, ts: Date.now() };
    } else {
      last = p.text;
      yield { type: 'transcript_partial', turnId, text: p.text, ts: Date.now() };
    }
  }
  yield { type: 'transcript_final', turnId, text: last, ts: Date.now() };
  yield { type: 'turn_end', turnId, ts: Date.now() };
}
