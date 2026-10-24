import Anthropic from '@anthropic-ai/sdk';
import type { Belief, Claim, MossHit } from '@ahead/contracts';
import { normalize } from './belief/normalize.js';
import { resolveDay } from './belief/entities.js';
import { requireEnv } from './env.js';
import { logLatency } from './log.js';

const YES = [
  'yes',
  'yeah',
  'yep',
  'sure',
  'ok',
  'okay',
  'apply',
  'apply it',
  'do it',
  'yes please',
  'go ahead',
];
const NO = ['no', 'nope', 'cancel', 'dont', "don't", 'no thanks', 'never mind', 'discard'];

export const FALLBACK_REPLY = "Sorry, I didn't catch that.";
export const APPLIED_REPLY = 'Done.';
export const DISCARDED_REPLY = 'Okay, I dropped it.';

export function parseConfirm(text: string): boolean | null {
  const n = normalize(text);
  if (YES.includes(n)) return true;
  if (NO.includes(n)) return false;
  return null;
}

export function mayBeConfirm(text: string): boolean {
  const n = normalize(text);
  if (!n) return true;
  const words = n.split(' ');
  return [...YES, ...NO].some((phrase) => {
    const pw = phrase.split(' ');
    return words.length <= pw.length && words.every((w, i) => w === pw[i]);
  });
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function stagedLine(belief: Belief): string {
  const first = belief.entities.person?.trim().split(/\s+/)[0] || 'them';
  switch (belief.intent) {
    case 'reschedule_event': {
      const day = belief.entities.to_weekday;
      return `I moved your meeting with ${first}${day ? ` to ${capitalize(day)}` : ''}. Apply?`;
    }
    case 'draft_message':
      return `I drafted a message to ${first}. Apply?`;
    case 'add_note':
      return 'I added the note. Apply?';
    case 'find_file':
      return 'I found the file. Open it?';
    default:
      return "It's ready. Apply?";
  }
}

export function correctionAck(value: string): string {
  return `Okay, ${capitalize(value)}.`;
}

export function claimForInterject(belief: Belief, text: string): Claim | undefined {
  const t = text.toLowerCase();
  return belief.claims.find(
    (c) => t.includes(c.said.toLowerCase()) && t.includes(c.known.toLowerCase()),
  );
}

export function correctBelief(belief: Belief, claim: Claim, today: Date): Belief {
  const entities = { ...belief.entities };
  const known = normalize(claim.known);
  entities[claim.field] = known;
  if (claim.field === 'day') {
    try {
      Object.assign(entities, resolveDay(known, today));
    } catch {
      // leave weekday/date_iso as they were
    }
  }
  return { ...belief, entities };
}

export interface Answerer {
  answer(question: string, hits: MossHit[]): Promise<string>;
}

const ANSWER_SYSTEM =
  "Answer the user's question in one short spoken sentence using only the snippets. If the snippets don't contain the answer, say you don't know.";

export class HaikuAnswerer implements Answerer {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  }

  async answer(question: string, hits: MossHit[]): Promise<string> {
    const snippets = hits.length
      ? hits.map((h, i) => `${i + 1}. ${h.snippet}`).join('\n')
      : '(none)';
    const t0 = performance.now();
    const msg = await this.client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 200,
      thinking: { type: 'disabled' },
      system: ANSWER_SYSTEM,
      messages: [{ role: 'user', content: `Question: ${question}\n\nSnippets:\n${snippets}` }],
    });
    logLatency('llm', 'answer', performance.now() - t0);
    const block = msg.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('haiku returned no text block');
    return block.text.trim();
  }
}
