import type { Belief, Claim, MossHit, ServerEvent } from '../src/index.js';
import { MOCK_MOSS_DOCS } from './moss.js';

/** PLAN.md section 5, utterance 1. */
export const DEMO_INTERJECTION =
  'Quick note, your meeting with Priya is Friday at two, not Thursday. Want me to say Friday?';

const hit = (docId: string, score: number): MossHit => {
  const doc = MOCK_MOSS_DOCS.find((d) => d.docId === docId);
  if (!doc) throw new Error(`unknown mock doc ${docId}`);
  return { docId, score, snippet: doc.text };
};

const DAY_CLAIM: Claim = { field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-priya-q3' };

type Step = {
  atMs: number;
  query: string;
  hits: MossHit[];
  belief: Omit<Belief, 'topHits'>;
  interject?: boolean;
};

// Timed against the demo-utterance-1 Ink fixture (one step per few turn.updates).
const STEPS: Step[] = [
  {
    atMs: 250,
    query: 'Draft a',
    hits: [],
    belief: { intent: 'unknown', entities: {}, claims: [], confidence: 0.1, latencyMs: { moss: 1.9 } },
  },
  {
    atMs: 1000,
    query: 'Draft a message to Priya',
    hits: [hit('contact-priya', 0.81), hit('evt-priya-q3', 0.62)],
    belief: {
      intent: 'draft_message',
      entities: { person: 'Priya' },
      claims: [],
      confidence: 0.55,
      latencyMs: { moss: 2.1, llm: 380 },
    },
  },
  {
    atMs: 1750,
    query: "Draft a message to Priya saying, I'll see",
    hits: [hit('contact-priya', 0.79), hit('evt-priya-q3', 0.66)],
    belief: {
      intent: 'draft_message',
      entities: { person: 'Priya' },
      claims: [],
      confidence: 0.78,
      latencyMs: { moss: 2.0, llm: 395 },
    },
  },
  {
    atMs: 2500,
    query: 'meeting with Priya Thursday',
    hits: [hit('evt-priya-q3', 0.91), hit('contact-priya', 0.74), hit('file-q3-deck', 0.41)],
    belief: {
      intent: 'draft_message',
      entities: { person: 'Priya' },
      claims: [DAY_CLAIM],
      confidence: 0.86,
      latencyMs: { moss: 2.3, llm: 410 },
    },
    interject: true,
  },
  {
    atMs: 3000,
    query: "Draft a message to Priya saying, I'll see her Thursday at 2",
    hits: [hit('evt-priya-q3', 0.88), hit('contact-priya', 0.72)],
    belief: {
      intent: 'draft_message',
      entities: { person: 'Priya' },
      claims: [DAY_CLAIM],
      confidence: 0.88,
      latencyMs: { moss: 2.2 },
    },
  },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Lane B stand-in for utterance 1, over about 3 s (divide by `speed`). Per step: `moss_hits`,
 * then `belief_update`. Intent goes unknown → draft_message {person:'Priya'} and locks (≥ 0.75)
 * before "Thursday"; at "Thursday" the belief carries the day claim (≥ 0.8) and one `interject`
 * follows. No `state_change`: that comes from Lane C's StateMachine.
 */
export async function* mockBeliefStream(
  turnId: string,
  opts: { speed?: number } = {},
): AsyncGenerator<ServerEvent> {
  const speed = opts.speed ?? 1;
  let prev = 0;
  for (const s of STEPS) {
    await sleep(Math.max(0, (s.atMs - prev) / speed));
    prev = s.atMs;
    yield { type: 'moss_hits', turnId, query: s.query, hits: s.hits, latencyMs: s.belief.latencyMs.moss };
    yield { type: 'belief_update', turnId, belief: { ...s.belief, topHits: s.hits } };
    if (s.interject) yield { type: 'interject', turnId, text: DEMO_INTERJECTION };
  }
}
