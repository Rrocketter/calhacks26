import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseServerEvent, type ServerEvent } from '../src/index.js';
import {
  MockMoss,
  mockBeliefStream,
  mockDroidRun,
  mockInkStream,
  type InkFixture,
} from '../mocks/index.js';
import { loadFixture } from '../mocks/node.js';

async function collect(gen: AsyncGenerator<ServerEvent>): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// Every mock event must survive the wire format, like a real server event.
function expectWireValid(events: ServerEvent[]): void {
  for (const e of events) expect(parseServerEvent(JSON.stringify(e))).toEqual(e);
}

const FINAL_TEXT =
  "Draft a message to Priya saying, I'll see her Thursday at 2 for the Q3 deck review.";

describe('mockInkStream', () => {
  it('replays demo-utterance-1 like real Ink: cumulative, "2", eager_end before final', async () => {
    const fx = loadFixture('demo-utterance-1');
    const events = await collect(mockInkStream(fx, { speed: 100 }));
    expectWireValid(events);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('turn_start');
    expect(types.slice(-2)).toEqual(['transcript_final', 'turn_end']);

    const partials = events.flatMap((e) => (e.type === 'transcript_partial' ? [e.text] : []));
    expect(partials[0]).toBe('Draft a');
    for (let i = 1; i < partials.length; i++) expect(partials[i]!.startsWith(partials[i - 1]!)).toBe(true);
    expect(partials.some((t) => t.includes('Thursday'))).toBe(true);
    expect(partials.some((t) => /\btwo\b/.test(t))).toBe(false);
    expect(partials.at(-1)).toBe(FINAL_TEXT);

    const eagerIdx = types.indexOf('turn_eager_end');
    expect(eagerIdx).toBeGreaterThan(0);
    expect(eagerIdx).toBeLessThan(types.indexOf('transcript_final'));
    const eager = events[eagerIdx];
    expect(eager?.type === 'turn_eager_end' && eager.text).toBe(FINAL_TEXT);
    const fin = events.find((e) => e.type === 'transcript_final');
    expect(fin?.type === 'transcript_final' && fin.text).toBe(FINAL_TEXT);

    const eagerAt = fx.partials.find((p) => p.eager)!.atMs;
    const finalAt = fx.partials.find((p) => p.final)!.atMs;
    expect(finalAt - eagerAt).toBeGreaterThanOrEqual(100);
    expect(finalAt - eagerAt).toBeLessThanOrEqual(200);
  });

  it('emits turn_resume for a resume entry and stops at the final entry', async () => {
    const fx: InkFixture = {
      turnId: 't9',
      partials: [
        { atMs: 0, text: 'Move my' },
        { atMs: 10, text: 'Move my', eager: true },
        { atMs: 20, text: 'Move my', resume: true },
        { atMs: 30, text: 'Move my Friday meeting.' },
        { atMs: 40, text: 'Move my Friday meeting.', final: true },
        { atMs: 50, text: 'ignored after final' },
      ],
    };
    const events = await collect(mockInkStream(fx, { speed: 100 }));
    expectWireValid(events);
    expect(events.map((e) => e.type)).toEqual([
      'turn_start',
      'transcript_partial',
      'turn_eager_end',
      'turn_resume',
      'transcript_partial',
      'transcript_final',
      'turn_end',
    ]);
    expect(events.every((e) => 'turnId' in e && e.turnId === 't9')).toBe(true);
  });

  it('ends after the last entry when none is final', async () => {
    const fx: InkFixture = { turnId: 't2', partials: [{ atMs: 0, text: 'Hi' }, { atMs: 5, text: 'Hi there' }] };
    const events = await collect(mockInkStream(fx, { speed: 100 }));
    expect(events.map((e) => e.type)).toEqual([
      'turn_start', 'transcript_partial', 'transcript_partial', 'transcript_final', 'turn_end',
    ]);
    const fin = events.find((e) => e.type === 'transcript_final');
    expect(fin?.type === 'transcript_final' && fin.text).toBe('Hi there');
  });
});

describe('mockBeliefStream', () => {
  it('rises from unknown to draft_message/Priya, then claims Thursday vs Friday and interjects once', async () => {
    const t0 = Date.now();
    const events = await collect(mockBeliefStream('demo-1', { speed: 10 }));
    const dt = Date.now() - t0;
    expectWireValid(events);
    expect(dt).toBeGreaterThanOrEqual(250);
    expect(dt).toBeLessThanOrEqual(600);
    expect(events.every((e) => 'turnId' in e && e.turnId === 'demo-1')).toBe(true);
    expect(events.some((e) => e.type === 'moss_hits')).toBe(true);

    const beliefs = events.flatMap((e) => (e.type === 'belief_update' ? [e.belief] : []));
    expect(beliefs[0]?.intent).toBe('unknown');
    expect(beliefs.at(-1)?.intent).toBe('draft_message');
    expect(beliefs.at(-1)?.entities).toEqual({ person: 'Priya' });
    for (let i = 1; i < beliefs.length; i++) {
      expect(beliefs[i]!.confidence).toBeGreaterThanOrEqual(beliefs[i - 1]!.confidence);
    }
    // Locks (>= SPECULATE_AT 0.75) before the claim shows up.
    const lockIdx = beliefs.findIndex((b) => b.intent === 'draft_message' && b.confidence >= 0.75);
    const claimIdx = beliefs.findIndex((b) => b.claims.length > 0);
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(claimIdx);
    const claimed = beliefs[claimIdx]!;
    expect(claimed.claims).toEqual([{ field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-priya-q3' }]);
    expect(claimed.confidence).toBeGreaterThanOrEqual(0.8);
    expect(claimed.topHits[0]?.docId).toBe('evt-priya-q3');

    const interjects = events.filter((e) => e.type === 'interject');
    expect(interjects).toHaveLength(1);
    expect(interjects[0]?.type === 'interject' && interjects[0].text).toBe(
      'Quick note, your meeting with Priya is Friday at two, not Thursday. Want me to say Friday?',
    );
    const claimEventIdx = events.findIndex((e) => e.type === 'belief_update' && e.belief.claims.length > 0);
    expect(events.findIndex((e) => e.type === 'interject')).toBeGreaterThan(claimEventIdx);
  });
});

describe('MockMoss', () => {
  it('uses the seed docIds and ranks evt-priya-q3 first for a meeting query', async () => {
    const r = await new MockMoss().query('meeting with Priya');
    expect(r.hits[0]?.docId).toBe('evt-priya-q3');
    expect(r.latencyMs).toBe(3);
    const all = await new MockMoss().query('Priya Shah Q3 deck', { k: 10 });
    expect(all.hits.map((h) => h.docId).sort()).toEqual(['contact-priya', 'evt-priya-q3', 'file-q3-deck']);
    expect(all.hits.find((h) => h.docId === 'contact-priya')?.snippet).toContain('priya.shah@example.com');
  });
  it('ranks file-q3-deck first for a deck query', async () => {
    const r = await new MockMoss().query('q3 deck pdf');
    expect(r.hits[0]?.docId).toBe('file-q3-deck');
  });
  it('respects k', async () => {
    const r = await new MockMoss().query('Priya', { k: 1 });
    expect(r.hits).toHaveLength(1);
  });
});

// Applies a single-hunk unified diff to `src` and returns the result.
function applyHunk(src: string, diff: string): string {
  const lines = diff.split('\n');
  const at = lines.findIndex((l) => l.startsWith('@@'));
  const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[at]!);
  if (!m) throw new Error('no hunk header');
  const body = lines.slice(at + 1).filter((l) => l !== '');
  const oldLines = body.filter((l) => !l.startsWith('+')).map((l) => l.slice(1));
  const newLines = body.filter((l) => !l.startsWith('-')).map((l) => l.slice(1));
  expect(oldLines).toHaveLength(Number(m[2]));
  expect(newLines).toHaveLength(Number(m[4]));
  const srcLines = src.split('\n');
  const start = Number(m[1]) - 1;
  expect(srcLines.slice(start, start + oldLines.length)).toEqual(oldLines);
  srcLines.splice(start, oldLines.length, ...newLines);
  return srcLines.join('\n');
}

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
    expectWireValid(events);
  });

  it('diff applies to workspace-seed/calendar.json and moves evt-priya-q3 to Mon 2026-11-02 09:00 -08:00', async () => {
    const events = await collect(mockDroidRun('t1'));
    const diffEv = events.find((e) => e.type === 'droid_event' && e.kind === 'diff');
    const payload = (diffEv?.type === 'droid_event' ? diffEv.payload : null) as { file: string; diff: string };
    expect(payload.file).toBe('calendar.json');
    const seedPath = fileURLToPath(new URL('../../../workspace-seed/calendar.json', import.meta.url));
    const seed = readFileSync(seedPath, 'utf8');
    const after = JSON.parse(applyHunk(seed, payload.diff)) as {
      events: { id: string; start: string; end: string }[];
    };
    const ev = after.events.find((e) => e.id === 'evt-priya-q3');
    expect(ev?.start).toBe('2026-11-02T09:00:00-08:00');
    expect(ev?.end).toBe('2026-11-02T10:00:00-08:00');
    expect(after.events).toHaveLength(5);
  });

  it('withDenied adds one denied tool event and keeps the default order otherwise', async () => {
    const events = await collect(mockDroidRun('t1', { withDenied: true }));
    expectWireValid(events);
    const kinds = events.map((e) => (e.type === 'droid_event' ? e.kind : e.type));
    expect(kinds.filter((k) => k !== 'tool')).toEqual(['plan', 'step', 'step', 'step', 'diff', 'result']);
    const tools = events.filter((e) => e.type === 'droid_event' && e.kind === 'tool');
    expect(tools).toHaveLength(1);
    const t = tools[0]!;
    expect(t.type === 'droid_event' && t.denied).toBe(true);
    expect(t.type === 'droid_event' && t.payload).toEqual({
      tool: 'Read', path: '../../.env', denied: true, reason: 'outside-workspace',
    });
  });
});

describe('mocks barrel is browser-safe', () => {
  it('no file reachable from mocks/index.ts imports node: modules', () => {
    const dir = fileURLToPath(new URL('../mocks/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'node.ts');
    expect(files).toContain('index.ts');
    for (const f of files) expect(readFileSync(dir + f, 'utf8')).not.toMatch(/from ['"]node:/);
  });
});
