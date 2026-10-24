import { z } from 'zod';
import { BeliefSchema, MossHitSchema, StateSchema } from './belief.js';
import { RETRIEVAL_MODES } from './moss.js';

export const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('audio_chunk'),
    pcm: z.string(),
    sampleRate: z.number(),
    seq: z.number(),
  }),
  z.object({
    type: z.literal('demo_control'),
    action: z.enum(['start', 'stop', 'reset']),
    fixture: z.string().optional(),
  }),
  z.object({
    type: z.literal('confirm_action'),
    turnId: z.string(),
    apply: z.boolean(),
  }),
  // The server answers with metric `retrieval:<mode>`; interject lag arrives as `interject_lag:<mode>`.
  z.object({ type: z.literal('retrieval_mode'), mode: z.enum(RETRIEVAL_MODES) }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn_start'), turnId: z.string(), ts: z.number() }),
  z.object({
    type: z.literal('transcript_partial'),
    turnId: z.string(),
    text: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('transcript_final'),
    turnId: z.string(),
    text: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('turn_eager_end'),
    turnId: z.string(),
    text: z.string(),
    ts: z.number(),
  }),
  z.object({ type: z.literal('turn_resume'), turnId: z.string(), ts: z.number() }),
  z.object({ type: z.literal('turn_end'), turnId: z.string(), ts: z.number() }),
  z.object({ type: z.literal('belief_update'), turnId: z.string(), belief: BeliefSchema }),
  z.object({
    type: z.literal('moss_hits'),
    turnId: z.string(),
    query: z.string(),
    hits: z.array(MossHitSchema),
    latencyMs: z.number(),
  }),
  z.object({ type: z.literal('state_change'), turnId: z.string(), state: StateSchema }),
  z.object({
    type: z.literal('droid_event'),
    turnId: z.string(),
    kind: z.enum(['plan', 'step', 'tool', 'diff', 'result']),
    payload: z.unknown(),
    denied: z.boolean().optional(),
    ts: z.number(),
  }),
  z.object({ type: z.literal('interject'), turnId: z.string(), text: z.string() }),
  // Every line AHEAD speaks, as text, so the HUD can caption it.
  z.object({
    type: z.literal('assistant_reply'),
    turnId: z.string(),
    text: z.string(),
    kind: z.enum(['answer', 'interject', 'prompt', 'ack']),
  }),
  z.object({
    type: z.literal('tts_audio_chunk'),
    turnId: z.string(),
    contextId: z.string(),
    pcm: z.string(),
    sampleRate: z.number(),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal('metric'),
    source: z.enum(['moss', 'ink', 'sonic', 'droid', 'llm']),
    label: z.string(),
    ms: z.number(),
  }),
  z.object({ type: z.literal('error'), message: z.string(), source: z.string().optional() }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ReplyKind = Extract<ServerEvent, { type: 'assistant_reply' }>['kind'];

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function parseClientEvent(raw: string): ClientEvent | null {
  return parse(ClientEventSchema, raw);
}

export function parseServerEvent(raw: string): ServerEvent | null {
  return parse(ServerEventSchema, raw);
}
