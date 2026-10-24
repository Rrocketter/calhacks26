import type { InkFixture } from '@ahead/contracts/mocks';
import type { InkMessage } from '../voice/turns.js';

export type TimedInkMessage = { atMs: number; msg: InkMessage };

/** Pure mapping of an Ink fixture to Ink messages, same semantics as mockInkStream. */
export function fixtureMessages(f: InkFixture): TimedInkMessage[] {
  const out: TimedInkMessage[] = [{ atMs: 0, msg: { type: 'turn.start' } }];
  let last = '';
  let lastAt = 0;
  for (const p of f.partials) {
    lastAt = p.atMs;
    if (p.final) {
      out.push({ atMs: p.atMs, msg: { type: 'turn.end', transcript: p.text } });
      return out;
    }
    if (p.eager) {
      out.push({ atMs: p.atMs, msg: { type: 'turn.eager_end', transcript: p.text } });
    } else if (p.resume) {
      out.push({ atMs: p.atMs, msg: { type: 'turn.resume' } });
    } else {
      last = p.text;
      out.push({ atMs: p.atMs, msg: { type: 'turn.update', transcript: last } });
    }
  }
  out.push({ atMs: lastAt, msg: { type: 'turn.end', transcript: last } });
  return out;
}

export async function playFixture(
  f: InkFixture,
  onInk: (m: InkMessage) => void,
  opts: { speed?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const speed = opts.speed ?? 1;
  const { signal } = opts;
  let prev = 0;
  for (const { atMs, msg } of fixtureMessages(f)) {
    if (signal?.aborted) return;
    const wait = Math.max(0, (atMs - prev) / speed);
    prev = atMs;
    if (wait > 0 && !(await sleep(wait, signal))) return;
    if (signal?.aborted) return;
    onInk(msg);
  }
}

/** Resolves true after ms, false if aborted first. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
