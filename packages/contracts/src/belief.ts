import { z } from 'zod';

export const ACTIONS = [
  'reschedule_event',
  'draft_message',
  'find_file',
  'add_note',
  'lookup',
] as const;

export const IntentSchema = z.enum([...ACTIONS, 'unknown']);
export type Intent = z.infer<typeof IntentSchema>;

export const StateSchema = z.enum([
  'LISTENING',
  'BELIEF_FORMING',
  'SPECULATING',
  'STAGED',
  'COMMITTED',
  'ROLLED_BACK',
]);
export type State = z.infer<typeof StateSchema>;

export const MossHitSchema = z.object({
  docId: z.string(),
  score: z.number(),
  snippet: z.string(),
});
export type MossHit = z.infer<typeof MossHitSchema>;

export const ClaimSchema = z.object({
  field: z.string(),
  said: z.string(),
  known: z.string(),
  docId: z.string(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const BeliefSchema = z.object({
  intent: IntentSchema,
  entities: z.record(z.string(), z.string()),
  claims: z.array(ClaimSchema),
  confidence: z.number().min(0).max(1),
  topHits: z.array(MossHitSchema),
  latencyMs: z.object({ moss: z.number(), llm: z.number().optional() }),
});
export type Belief = z.infer<typeof BeliefSchema>;
