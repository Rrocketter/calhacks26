import type { Belief, ServerEvent } from '@ahead/contracts';
import type { DroidStreamEvent } from '@factory/droid-sdk/node';

export type Emit = (ev: ServerEvent) => void;

export interface Phase2Hooks {
  onStaged?: () => void;
}

export interface Executor {
  warm(): Promise<void>; // pre-create session at LISTENING
  phase1(turnId: string, belief: Belief): Promise<void>; // prepare branch + Phase 1 prompt
  // Slots prompt; on the first landed edit commits it on the branch, emits the diff and calls
  // onStaged. Settles at turn end (informational once staged).
  phase2(turnId: string, belief: Belief, hooks?: Phase2Hooks): Promise<void>;
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

const ERROR_CAP = 200;

// Short single-line message with every env value of 8+ chars masked.
export function redact(e: unknown, fallback = 'droid session failed'): string {
  let msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
  for (const v of Object.values(process.env)) if (v && v.length >= 8) msg = msg.split(v).join('[redacted]');
  return (msg || fallback).slice(0, ERROR_CAP);
}
