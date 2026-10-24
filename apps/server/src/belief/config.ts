// Short on purpose: the mic is muted while it plays.
/** {event}: "the VQE meeting"; {at}: " at 8:30" for a day claim when the event has a time, else empty. */
export const INTERJECT_TEMPLATE = 'Heads up, {event} is {known}{at}, not {said}. Say {known}?';

export const BELIEF_CONFIG = {
  SPECULATE_AT: 0.75,
  INTERJECT_AT: 0.8,
  LLM_EVERY_N_UPDATES: 2,
  MAX_LLM_IN_FLIGHT: 2,
  RECENCY_DECAY: 0.6,
  TOP_HITS: 5,
  W_LLM: 0.6,
  W_MOSS: 0.4,
} as const;

export type BeliefConfig = typeof BELIEF_CONFIG;
