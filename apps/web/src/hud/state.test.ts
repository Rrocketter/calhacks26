import { describe, expect, it } from 'vitest';
import type { Belief, ServerEvent } from '@ahead/contracts';
import { findWord, hudReducer, initialHud, isMemoryHit, panelHits, pendingConfirm, type HudAction, type HudState } from './state';

const TEXT = "Draft a message to Priya saying, I'll see her Thursday";

const run = (actions: HudAction[], s: HudState = initialHud()): HudState =>
  actions.reduce(hudReducer, s);

const start = (turnId: string): ServerEvent => ({ type: 'turn_start', turnId, ts: 0 });
const partial = (turnId: string, text: string): ServerEvent => ({
  type: 'transcript_partial',
  turnId,
  text,
  ts: 0,
});
const belief = (said: string): Belief => ({
  intent: 'draft_message',
  entities: {},
  claims: [{ field: 'day', said, known: 'Friday', docId: 'd1' }],
  confidence: 0.9,
  topHits: [],
  latencyMs: { moss: 1 },
});
const droid = (
  turnId: string,
  kind: 'plan' | 'step' | 'tool' | 'diff' | 'result',
  payload: unknown,
  denied?: boolean,
): ServerEvent => ({ type: 'droid_event', turnId, kind, payload, denied, ts: 0 });
const moss = (turnId: string, latencyMs: number): ServerEvent => ({
  type: 'moss_hits',
  turnId,
  query: 'q',
  hits: [],
  latencyMs,
});

describe('findWord', () => {
  it('finds the token index ignoring case and punctuation', () => {
    expect(findWord(`${TEXT},`, 'thursday')).toBe(9);
    expect(findWord('Draft a', 'Thursday')).toBeNull();
  });
});

describe('hudReducer', () => {
  it('resolves the interject word and keeps the highlight in finals', () => {
    let s = run([
      start('t1'),
      partial('t1', 'Draft a message'),
      { type: 'belief_update', turnId: 't1', belief: belief('Thursday') },
      partial('t1', TEXT),
      { type: 'interject', turnId: 't1', text: 'Friday?' },
    ]);
    expect(s.interject?.wordIndex).toBe(9);
    s = run([{ type: 'transcript_final', turnId: 't1', text: TEXT, ts: 0 }], s);
    expect(s.finals.at(-1)?.highlight).toBe(9);
    expect(s.partial).toBe('');
    s = run([start('t2'), partial('t2', 'Also')], s);
    expect(s.interject).toBeNull();
    expect(s.finals.at(-1)?.highlight).toBe(9);
  });

  it('resolves a null wordIndex on a later partial', () => {
    let s = run([
      start('t1'),
      { type: 'belief_update', turnId: 't1', belief: belief('Thursday') },
      partial('t1', "Draft a message to Priya saying, I'll see"),
      { type: 'interject', turnId: 't1', text: 'Friday?' },
    ]);
    expect(s.interject?.wordIndex).toBeNull();
    s = run([partial('t1', TEXT)], s);
    expect(s.interject?.wordIndex).toBe(9);
  });

  it('counts moss hits and resets when the next turn speaks', () => {
    let s = run([start('t1'), moss('t1', 2), moss('t1', 3)]);
    expect(s.moss).toEqual({ count: 2, totalMs: 5, lastMs: 3 });
    s = run([start('t2'), partial('t2', 'Hey')], s);
    expect(s.moss.count).toBe(0);
  });

  it('keeps the finished turn live across a bare turn_start', () => {
    let s = run([
      start('t1'),
      partial('t1', TEXT),
      moss('t1', 2),
      { type: 'transcript_final', turnId: 't1', text: TEXT, ts: 0 },
      { type: 'error', message: 'boom' },
      start('t2'),
      partial('t2', ''),
      { type: 'belief_update', turnId: 't1', belief: belief('Thursday') },
      moss('t1', 4),
    ]);
    expect(s.turnId).toBe('t1');
    expect(s.belief?.claims[0]?.said).toBe('Thursday');
    expect(s.moss).toEqual({ count: 2, totalMs: 6, lastMs: 4 });
    s = run([partial('t2', 'Also')], s);
    expect(s.turnId).toBe('t2');
    expect(s.partial).toBe('Also');
    expect(s.moss).toEqual({ count: 0, totalMs: 0, lastMs: null });
    expect(s.error).toBeNull();
    // A late partial for the finished turn doesn't take the turn back.
    s = run([partial('t1', TEXT)], s);
    expect(s.turnId).toBe('t2');
  });

  it('highlights the claim the interject is about', () => {
    const b: Belief = {
      ...belief('Thursday'),
      claims: [
        { field: 'time', said: '3pm', known: '4pm', docId: 'd2' },
        { field: 'day', said: 'Thursday', known: 'Friday', docId: 'd1' },
      ],
    };
    const s = run([
      start('t1'),
      partial('t1', TEXT),
      { type: 'belief_update', turnId: 't1', belief: b },
      { type: 'interject', turnId: 't1', text: 'Say Friday?' },
    ]);
    expect(s.interject?.said).toBe('Thursday');
    expect(s.interject?.wordIndex).toBe(9);
  });

  it('ignores stale belief and moss events', () => {
    const s = run([
      start('t1'),
      { type: 'belief_update', turnId: 't1', belief: belief('Thursday') },
      start('t2'),
      partial('t2', 'Hey'),
      { type: 'belief_update', turnId: 't1', belief: belief('Monday') },
      moss('t1', 2),
    ]);
    expect(s.belief?.claims[0]?.said).toBe('Thursday');
    expect(s.moss.count).toBe(0);
  });

  it('tracks reached states per turn', () => {
    const states = ['LISTENING', 'BELIEF_FORMING', 'SPECULATING', 'STAGED', 'COMMITTED'] as const;
    let s = run(states.map((state) => ({ type: 'state_change', turnId: 't1', state })));
    expect(s.reached).toEqual([...states]);
    s = run([{ type: 'state_change', turnId: 't2', state: 'LISTENING' }], s);
    expect(s.reached).toEqual(['LISTENING']);
  });

  it('marks a denied tool', () => {
    const s = run([
      droid('t1', 'tool', { tool: 'Read', path: '/etc/passwd', reason: 'outside-workspace' }, true),
    ]);
    expect(s.tools[0]).toMatchObject({ denied: true, reason: 'outside-workspace' });
  });

  it('keeps diffs on a failed result', () => {
    const s = run([
      droid('t1', 'diff', { file: 'calendar.json', diff: '+x' }),
      droid('t1', 'result', { ok: false, failed: true, summary: 'droid turn failed after staging' }),
    ]);
    expect(s.result?.failed).toBe(true);
    expect(s.diffs).toHaveLength(1);
  });

  it('upserts diffs by file', () => {
    const s = run([
      droid('t1', 'diff', { file: 'calendar.json', diff: 'one' }),
      droid('t1', 'diff', { file: 'calendar.json', diff: 'two' }),
    ]);
    expect(s.diffs).toEqual([{ file: 'calendar.json', diff: 'two' }]);
  });

  it('survives malformed droid payloads', () => {
    const s = run([
      droid('t1', 'plan', { steps: ['a'] }),
      droid('t1', 'plan', { steps: 'x' }),
      droid('t1', 'result', {}),
    ]);
    expect(s.plan).toEqual(['a']);
    expect(s.result).toEqual({ ok: false, summary: '', failed: false });
  });

  it('resets executor fields on a new droid turn', () => {
    const s = run([
      droid('t1', 'plan', { steps: ['a'] }),
      droid('t1', 'step', { text: 'did a' }),
      droid('t1', 'tool', { tool: 'Edit' }),
      droid('t1', 'diff', { file: 'f', diff: 'd' }),
      droid('t1', 'result', { ok: true, summary: 'done' }),
      droid('t2', 'step', { text: 'new' }),
    ]);
    expect(s.droidTurnId).toBe('t2');
    expect(s.plan).toEqual([]);
    expect(s.steps).toEqual(['new']);
    expect(s.tools).toEqual([]);
    expect(s.diffs).toEqual([]);
    expect(s.result).toBeNull();
  });

  it('opens and closes the confirm window from the confirm_window metric', () => {
    let s = run([{ type: 'metric', source: 'ink', label: 'confirm_window:correction:t1', ms: 4000 }]);
    expect(s.confirm).toEqual({ kind: 'correction', turnId: 't1' });
    expect(pendingConfirm(s, 'live', true)).toEqual({ kind: 'correction', turnId: 't1' });
    expect(pendingConfirm(s, 'live', false)).toBeNull();
    expect(s.ttfa).toEqual({});
    s = run([{ type: 'metric', source: 'ink', label: 'confirm_window', ms: 0 }], s);
    expect(s.confirm).toBeNull();
    s = run([{ type: 'metric', source: 'ink', label: 'confirm_window:apply:t2', ms: 6000 }], s);
    expect(s.confirm).toEqual({ kind: 'apply', turnId: 't2' });
  });

  it('tracks ttfa, errors and reset', () => {
    let s = run([
      { type: 'metric', source: 'sonic', label: 'ttfa', ms: 120 },
      { type: 'client_ttfa', ms: 180 },
      { type: 'error', message: 'boom' },
    ]);
    expect(s.ttfa).toEqual({ server: 120, client: 180 });
    expect(s.error).toBe('server: boom');
    s = run([{ type: 'turn_end', turnId: 't1', ts: 0 }], s);
    expect(s.ttfa).toEqual({});
    expect(run([{ type: 'reset' }], s)).toEqual(initialHud());
  });
});

describe('memory hits in the Moss panel', () => {
  const hit = (docId: string) => ({ docId, score: 0.5, snippet: docId });
  it('tags memory docs by id prefix', () => {
    expect(isMemoryHit(hit('memory-t-1-artifact'))).toBe(true);
    expect(isMemoryHit(hit('contact-priya'))).toBe(false);
  });
  it('shows the top 3 plus memory hits ranked below them', () => {
    const ids = panelHits(['c1', 'c2', 'c3', 'memory-a', 'c4', 'memory-b'].map(hit)).map((h) => h.docId);
    expect(ids).toEqual(['c1', 'c2', 'c3', 'memory-a', 'memory-b']);
    expect(panelHits(['memory-a', 'c1', 'c2', 'c3'].map(hit)).map((h) => h.docId)).toEqual(['memory-a', 'c1', 'c2']);
  });
});

describe('retrieval A/B', () => {
  const metric = (label: string, ms: number): ServerEvent => ({ type: 'metric', source: 'moss', label, ms });
  it('tracks the confirmed mode and the last interject lag per mode, across a demo reset', () => {
    const s = run([metric('retrieval:cloud-sim', 300), metric('interject_lag:cloud-sim', 2100), metric('interject_lag:moss', 400)]);
    expect(s.retrieval).toBe('cloud-sim');
    expect(s.interjectLag).toEqual({ 'cloud-sim': 2100, moss: 400 });
    const r = hudReducer(s, { type: 'reset' });
    expect(r.retrieval).toBe('cloud-sim');
    expect(r.interjectLag).toEqual({ 'cloud-sim': 2100, moss: 400 });
    expect(run([metric('retrieval:pinecone', 0)]).retrieval).toBe('moss');
  });
});

describe('assistant replies', () => {
  const reply = (turnId: string, text: string): ServerEvent => ({ type: 'assistant_reply', turnId, text, kind: 'ack' });
  it('keeps the last six spoken lines in order, and a reset clears them', () => {
    const s = run(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t, i) => reply(`t${i}`, t)));
    expect(s.replies.map((r) => r.text)).toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
    expect(s.replies[0]).toEqual({ seq: 2, turnId: 't1', text: 'b', kind: 'ack' });
    expect(hudReducer(s, { type: 'reset' }).replies).toEqual([]);
  });
});
