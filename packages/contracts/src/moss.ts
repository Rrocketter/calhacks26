export const MOSS_INDEX = { spike: 'ahead-spike', corpus: 'ahead-corpus', memory: 'ahead-memory' } as const;

/** Conversation-memory docs (index `ahead-memory`) have ids with this prefix; the HUD tags them "memory". */
export const MEMORY_DOC_PREFIX = 'memory-';

/** Retrieval A/B: in-process Moss, or the same Moss results after a simulated 300 ms cloud round trip. */
export const RETRIEVAL_MODES = ['moss', 'cloud-sim'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
/** Added to every query in cloud-sim mode. */
export const CLOUD_SIM_MS = 300;
