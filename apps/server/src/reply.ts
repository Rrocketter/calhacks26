import Anthropic from '@anthropic-ai/sdk';
import type { Belief, Claim, MossHit } from '@ahead/contracts';
import { normalize } from './belief/normalize.js';
import { resolveDay } from './belief/entities.js';
import { requireEnv } from './env.js';
import { logLatency } from './log.js';

// Spoken confirm lexicon, matched after normalize(). A confirm is made only of phrases from one
// side (plus filler), so "yeah do it" is a yes and "okay so move my meeting" is neither.
const YES = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'apply', 'apply it', 'do it', 'go ahead'];
const NO = ['no', 'nope', "don't", 'dont', 'cancel', 'discard', 'drop it', 'never mind'];
const FILLER = ['please', 'thanks', 'thank you', 'um', 'uh'];

export const FALLBACK_REPLY = "Sorry, I didn't catch that.";
export const APPLIED_REPLY = 'Done.';
export const DISCARDED_REPLY = 'Dropped.';

/** true = yes, false = no, null = not a confirm. */
export function parseConfirm(text: string): boolean | null {
  const words = normalize(text).split(' ').filter(Boolean);
  let yes = false;
  let no = false;
  let i = 0;
  outer: while (i < words.length) {
    // Longest phrase first, so "drop it" is not read as an unknown "drop".
    for (const len of [2, 1]) {
      const phrase = words.slice(i, i + len).join(' ');
      if (phrase.split(' ').length !== len) continue;
      if (YES.includes(phrase)) yes = true;
      else if (NO.includes(phrase)) no = true;
      else if (!FILLER.includes(phrase)) continue;
      i += len;
      continue outer;
    }
    return null;
  }
  return yes === no ? null : yes;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function stagedLine(belief: Belief): string {
  return belief.intent === 'find_file' ? 'Open it?' : 'Apply?';
}

export function correctionAck(value: string): string {
  return `${capitalize(value)}.`;
}

export function claimForInterject(belief: Belief, text: string): Claim | undefined {
  // The interject only names the known value ("Say Friday?").
  const t = text.toLowerCase();
  return belief.claims.find((c) => t.includes(c.known.toLowerCase()));
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
