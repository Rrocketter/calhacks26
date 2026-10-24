import Anthropic from '@anthropic-ai/sdk';
import { ACTIONS, ClaimSchema, IntentSchema, type MossHit } from '@ahead/contracts';
import { logLatency } from '../log.js';
import type { IntentLlm, IntentResult } from './types.js';

export const HAIKU_MODEL = 'claude-haiku-5-5';

const SYSTEM = `You classify what a user wants from a partial, still-being-spoken voice transcript.
Pick exactly one intent:
- reschedule_event: move or change the time/day of a calendar event
- draft_message: write a message, email, or text to someone
- find_file: locate or open a file or document
- add_note: save a note or reminder
- lookup: answer a question from the user's calendar, contacts, notes, email, or files
- unknown: not enough information yet
The transcript may be cut off mid-sentence. Use the numbered context documents (from the user's own data) to resolve people, days, and files.
Return:
- entities: key/value pairs you can extract (keys such as person, day, time, file, topic). Use the person's name as spoken.
- claims: only when the user states a fact that a context document contradicts. field is what is wrong (e.g. day, time), said is what the user said, known is what the document says, docId is that document's id. Otherwise an empty list.
- confidence: 0 to 1, how sure you are of the intent given the partial so far.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'entities', 'claims', 'confidence'],
  properties: {
    intent: { type: 'string', enum: [...ACTIONS, 'unknown'] },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value'],
        properties: { key: { type: 'string' }, value: { type: 'string' } },
      },
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'said', 'known', 'docId'],
        properties: {
          field: { type: 'string' },
          said: { type: 'string' },
          known: { type: 'string' },
          docId: { type: 'string' },
        },
      },
    },
    confidence: { type: 'number' },
  },
} as const;

export function buildUserContent(partial: string, topHits: MossHit[], final?: boolean): string {
  const docs = topHits.length
    ? topHits.map((h, i) => `${i + 1}. ${h.docId}: ${h.snippet}`).join('\n')
    : '(none)';
  return `Transcript (${final ? 'final' : 'partial'}): ${partial}\n\nContext documents:\n${docs}`;
}

export function parseIntentJson(text: string): IntentResult {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const intent = IntentSchema.parse(raw.intent);
  if (!Array.isArray(raw.entities)) throw new Error('entities is not an array');
  const entities: Record<string, string> = {};
  for (const e of raw.entities as unknown[]) {
    const { key, value } = (e ?? {}) as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || typeof value !== 'string') throw new Error('bad entity');
    if (key && value) entities[key] = value;
  }
  const claims = ClaimSchema.array().parse(raw.claims);
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) {
    throw new Error('confidence is not a number');
  }
  const confidence = Math.min(1, Math.max(0, raw.confidence));
  return { intent, entities, claims, confidence };
}

export class HaikuIntentLlm implements IntentLlm {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async classify(input: {
    partial: string;
    topHits: MossHit[];
    final?: boolean;
  }): Promise<{ result: IntentResult; latencyMs: number }> {
    const t0 = performance.now();
    const msg = await this.client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        { role: 'user', content: buildUserContent(input.partial, input.topHits, input.final) },
      ],
    });
    const latencyMs = performance.now() - t0;
    logLatency('llm', 'intent', latencyMs);
    if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') {
      throw new Error(`haiku stop_reason ${msg.stop_reason}`);
    }
    const block = msg.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('haiku returned no text block');
    return { result: parseIntentJson(block.text), latencyMs };
  }
}
