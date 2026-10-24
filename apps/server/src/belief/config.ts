export const INTERJECT_TEMPLATE = "Heads up, {person}'s meeting is {known}, not {said}. Say {known}?";

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
