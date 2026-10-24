import { describe, expect, it } from 'vitest';
import { ACTIONS, MOSS_INDEX, parseClientEvent, parseServerEvent } from '../src/index.js';

describe('parseServerEvent', () => {
  it('accepts state_change', () => {
    const ev = { type: 'state_change', turnId: 't1', state: 'STAGED' };
    expect(parseServerEvent(JSON.stringify(ev))).toEqual(ev);
  });
  it('rejects unknown type, bad json, bad state', () => {
    expect(parseServerEvent('{"type":"nope"}')).toBeNull();
    expect(parseServerEvent('not json')).toBeNull();
    expect(
      parseServerEvent(JSON.stringify({ type: 'state_change', turnId: 't1', state: 'DONE' })),
    ).toBeNull();
  });
  it('round-trips belief_update', () => {
    const ev = {
      type: 'belief_update',
      turnId: 't1',
      belief: {
        intent: 'draft_message',
        entities: { person: 'Priya' },
        claims: [{ field: 'day', said: 'Thursday', known: 'Friday', docId: 'cal-priya' }],
        confidence: 0.82,
        topHits: [{ docId: 'cal-priya', score: 0.9, snippet: 'Meeting Friday 2 PM' }],
        latencyMs: { moss: 4.2, llm: 380 },
      },
    };
    expect(parseServerEvent(JSON.stringify(ev))).toEqual(ev);
  });
});

describe('parseClientEvent', () => {
  it('accepts confirm_action and rejects non-boolean apply', () => {
    const ok = { type: 'confirm_action', turnId: 't1', apply: true };
    expect(parseClientEvent(JSON.stringify(ok))).toEqual(ok);
    expect(parseClientEvent(JSON.stringify({ ...ok, apply: 'yes' }))).toBeNull();
  });
});

describe('constants', () => {
  it('ACTIONS has five entries without unknown', () => {
    expect(ACTIONS).toHaveLength(5);
    expect(ACTIONS).not.toContain('unknown');
  });
  it('MOSS_INDEX names', () => {
    expect(MOSS_INDEX.spike).toBe('ahead-spike');
    expect(MOSS_INDEX.corpus).toBe('ahead-corpus');
  });
});
