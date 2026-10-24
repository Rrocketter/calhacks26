import type { Belief, ServerEvent } from '@ahead/contracts';
import type { DroidStreamEvent } from '@factory/droid-sdk/node';

export type Emit = (ev: ServerEvent) => void;

export interface Executor {
  warm(): Promise<void>; // pre-create session at LISTENING
  phase1(turnId: string, belief: Belief): Promise<void>; // prepare branch + Phase 1 prompt
  phase2(turnId: string, belief: Belief): Promise<void>; // slots prompt, commit on branch, emit diff+result
  resetToPhase1(turnId: string): Promise<void>; // turn.resume
  commit(turnId: string): Promise<void>;
  rollback(turnId: string): Promise<void>;
}

// Subset of DroidSession the executor uses, so tests can fake it.
export interface DroidLike {
  stream(prompt: string, opts?: { includePartialMessages?: boolean }): AsyncIterable<DroidStreamEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export class SpeculationFailed extends Error {
  override name = 'SpeculationFailed';
}
