import { describe, expect, it } from 'vitest';
import { ServerEventSchema, type ServerEvent } from '../src/index.js';
import { MockMoss, loadFixture, mockDroidRun, mockInkStream } from '../mocks/index.js';

async function collect(gen: AsyncGenerator<ServerEvent>): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('mockInkStream', () => {
  it('yields turn_start first, turn_end last, and a Thursday partial', async () => {
    const events = await collect(mockInkStream(loadFixture('demo-utterance-1'), { speed: 100 }));
    expect(events[0]?.type).toBe('turn_start');
    expect(events.at(-1)?.type).toBe('turn_end');
    expect(
      events.some((e) => e.type === 'transcript_partial' && e.text.includes('Thursday')),
    ).toBe(true);
    expect(events.some((e) => e.type === 'transcript_final')).toBe(true);
    for (const e of events) expect(ServerEventSchema.safeParse(e).success).toBe(true);
  });
});

describe('MockMoss', () => {
  it('ranks cal-priya first for a meeting query', async () => {
    const r = await new MockMoss().query('meeting with Priya');
    expect(r.hits[0]?.docId).toBe('cal-priya');
    expect(r.latencyMs).toBe(3);
  });
  it('respects k', async () => {
    const r = await new MockMoss().query('Priya', { k: 1 });
    expect(r.hits).toHaveLength(1);
  });
});

describe('mockDroidRun', () => {
  it('emits plan, 3 steps, diff, result over about 2s', async () => {
    const t0 = Date.now();
    const events = await collect(mockDroidRun('t1'));
    const dt = Date.now() - t0;
    expect(events.map((e) => (e.type === 'droid_event' ? e.kind : e.type))).toEqual([
      'plan', 'step', 'step', 'step', 'diff', 'result',
    ]);
    expect(dt).toBeGreaterThanOrEqual(1800);
    expect(dt).toBeLessThanOrEqual(2400);
    for (const e of events) expect(ServerEventSchema.safeParse(e).success).toBe(true);
  });
});
