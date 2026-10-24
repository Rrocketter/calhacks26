import { describe, expect, it } from 'vitest';
import { ACTIONS, MOSS_INDEX, parseClientEvent, parseServerEvent } from '../src/index.js';

describe('parseServerEvent', () => {
  it('accepts state_change', () => {
    const ev = { type: 'state_change', turnId: 't1', state: 'STAGED' };
    expect(parseServerEvent(JSON.stringify(ev))).toEqual(ev);
  });
  it('accepts turn_eager_end and turn_resume, rejects turn_eager_end without text', () => {
    const eager = { type: 'turn_eager_end', turnId: 't1', text: 'draft 2 pm', ts: 5 };
    const resume = { type: 'turn_resume', turnId: 't1', ts: 6 };
    expect(parseServerEvent(JSON.stringify(eager))).toEqual(eager);
    expect(parseServerEvent(JSON.stringify(resume))).toEqual(resume);
    expect(
      parseServerEvent(JSON.stringify({ type: 'turn_eager_end', turnId: 't1', ts: 5 })),
    ).toBeNull();
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
        claims: [{ field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-priya-q3' }],
        confidence: 0.82,
        topHits: [{ docId: 'evt-priya-q3', score: 0.9, snippet: 'Calendar event: Q3 deck review with Priya Shah, Friday 2 PM' }],
        latencyMs: { moss: 4.2, llm: 380 },
      },
    };
    expect(parseServerEvent(JSON.stringify(ev))).toEqual(ev);
  });
});

describe('parseClientEvent', () => {
  it('accepts retrieval_mode moss and cloud-sim only', () => {
    expect(parseClientEvent(JSON.stringify({ type: 'retrieval_mode', mode: 'moss' }))).not.toBeNull();
    expect(parseClientEvent(JSON.stringify({ type: 'retrieval_mode', mode: 'cloud-sim' }))).not.toBeNull();
    expect(parseClientEvent(JSON.stringify({ type: 'retrieval_mode', mode: 'pinecone' }))).toBeNull();
  });

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
    expect(MOSS_INDEX.memory).toBe('ahead-memory');
  });
});
