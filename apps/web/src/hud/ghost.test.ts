import { describe, expect, it } from 'vitest';
import type { Belief } from '@ahead/contracts';
import { ghostOpacity, ghostParts } from './ghost';

const belief = (b: Partial<Belief>): Belief => ({
  intent: 'draft_message',
  entities: {},
  claims: [],
  confidence: 0.8,
  topHits: [],
  latencyMs: { moss: 2 },
  ...b,
});

describe('ghostParts', () => {
  it('has no guess without a belief or with an unknown intent', () => {
    expect(ghostParts(null)).toBeNull();
    expect(ghostParts(belief({ intent: 'unknown', entities: { person: 'Priya' } }))).toBeNull();
  });

  it('builds a draft from person, day, time and topic', () => {
    const b = belief({ entities: { person: 'Priya Shah', day: 'friday', time: '2 pm', topic: 'Q3 review' } });
    expect(ghostParts(b)).toEqual(['draft to Priya Shah', 'about Friday 2 PM Q3 review']);
  });

  it('grows as entities arrive', () => {
    expect(ghostParts(belief({}))).toEqual(['draft a message']);
    expect(ghostParts(belief({ entities: { person: 'Priya' } }))).toEqual(['draft to Priya']);
  });

  it('prefers the resolved weekday and lets a claim correct what was said', () => {
    const b = belief({
      entities: { person: 'Priya', day: 'thursday', weekday: 'thursday', time: 'at 2' },
      claims: [{ field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-priya-q3' }],
    });
    expect(ghostParts(b)).toEqual(['draft to Priya', 'about Friday at 2']);
  });

  it('moves a meeting only to an explicit target day', () => {
    const e = { person: 'Priya', day: 'thursday', time: '3 pm' };
    expect(ghostParts(belief({ intent: 'reschedule_event', entities: e }))).toEqual(['move the meeting with Priya']);
    expect(ghostParts(belief({ intent: 'reschedule_event', entities: { ...e, to_weekday: 'friday' } }))).toEqual([
      'move the meeting with Priya',
      'to Friday 3 PM',
    ]);
  });

  it('covers the other actions', () => {
    expect(ghostParts(belief({ intent: 'find_file', entities: { file: 'q3 deck', person: 'Priya' } }))).toEqual([
      'find q3 deck',
      'from Priya',
    ]);
    expect(ghostParts(belief({ intent: 'add_note', entities: { topic: 'budget', day: 'monday' } }))).toEqual([
      'note budget',
      'for Monday',
    ]);
    expect(ghostParts(belief({ intent: 'lookup', entities: {} }))).toEqual(['look up that']);
  });
});

describe('ghostOpacity', () => {
  it('is 0 at or below the floor, 1 from the lock line, linear between', () => {
    expect(ghostOpacity(0.1)).toBe(0);
    expect(ghostOpacity(0.3)).toBe(0);
    expect(ghostOpacity(0.525)).toBeCloseTo(0.5);
    expect(ghostOpacity(0.75)).toBe(1);
    expect(ghostOpacity(0.9)).toBe(1);
  });
});
