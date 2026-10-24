import type { Belief, Intent, State } from '@ahead/contracts';

export const LOCK_CONFIDENCE = 0.75;
export const SPECULATIVE: readonly Intent[] = ['reschedule_event', 'draft_message', 'find_file', 'add_note'];

export type SmEvent =
  | { type: 'turn_start'; turnId: string }
  | { type: 'belief'; belief: Belief }
  | { type: 'eager_end' }
  | { type: 'resume' }
  | { type: 'turn_end'; belief: Belief | null }
  // Phase 2's edit landed (early diff), or the turn ended with no edit.
  | { type: 'staged' }
  | { type: 'failed' }
  | { type: 'confirm'; apply: boolean };

export type Effect =
  | { type: 'phase1'; turnId: string; belief: Belief }
  | { type: 'phase2'; turnId: string; belief: Belief }
  | { type: 'reset_phase1'; turnId: string }
  | { type: 'commit'; turnId: string }
  | { type: 'rollback'; turnId: string }
  | { type: 'warm' }
  | { type: 'state'; state: State };

export type SmCtx = {
  turnId: string | null;
  state: State;
  locked: Belief | null;
  latest: Belief | null;
  phase2Sent: boolean;
  turnEnded: boolean;
  pendingApply: boolean | null;
  // Set by failed / confirm(false): the user or executor rejected this turn, so no relock.
  noRelock: boolean;
};

type Result = { ctx: SmCtx; effects: Effect[] };

export function initial(): SmCtx {
  return {
    turnId: null,
    state: 'LISTENING',
    locked: null,
    latest: null,
    phase2Sent: false,
    turnEnded: false,
    pendingApply: null,
    noRelock: false,
  };
}

export function transition(ctx: SmCtx, ev: SmEvent): Result {
  if (ev.type === 'turn_start') {
    const fresh: SmCtx = { ...initial(), turnId: ev.turnId };
    const live = ctx.turnId !== null && (ctx.state === 'SPECULATING' || ctx.state === 'STAGED');
    const dropped: Effect[] = live ? [{ type: 'rollback', turnId: ctx.turnId! }, { type: 'warm' }] : [];
    return { ctx: fresh, effects: [...dropped, { type: 'state', state: 'LISTENING' }] };
  }
  if (ctx.turnId === null || ctx.state === 'COMMITTED') return { ctx, effects: [] };
  switch (ev.type) {
    case 'belief':
      return onBelief(ctx, ev.belief);
    case 'eager_end':
      return sendPhase2(ctx);
    case 'staged':
      return onStaged(ctx);
    case 'failed':
      // In STAGED the diff is already shown; a later turn failure is informational (the executor
      // emits result failed:true for the HUD).
      return ctx.state === 'SPECULATING' ? rollback({ ...ctx, noRelock: true }) : { ctx, effects: [] };
    case 'resume':
      if (!(ctx.state === 'STAGED' || (ctx.state === 'SPECULATING' && ctx.phase2Sent))) return { ctx, effects: [] };
      return {
        ctx: { ...ctx, state: 'SPECULATING', phase2Sent: false },
        effects: [{ type: 'reset_phase1', turnId: ctx.turnId }, { type: 'state', state: 'SPECULATING' }],
      };
    case 'turn_end':
      return onTurnEnd(ctx, ev.belief);
    case 'confirm':
      return onConfirm(ctx, ev.apply);
    default:
      return { ctx, effects: [] };
  }
}

function onStaged(ctx: SmCtx): Result {
  if (ctx.state !== 'SPECULATING' || !ctx.phase2Sent) return { ctx, effects: [] };
  const staged: Result = { ctx: { ...ctx, state: 'STAGED' }, effects: [{ type: 'state', state: 'STAGED' }] };
  if (ctx.pendingApply !== true) return staged;
  const done = commit(staged.ctx);
  return { ctx: done.ctx, effects: [...staged.effects, ...done.effects] };
}

function onTurnEnd(prev: SmCtx, belief: Belief | null): Result {
  const ctx: SmCtx = { ...prev, turnEnded: true, latest: belief ?? prev.latest };
  if (ctx.state !== 'SPECULATING' && ctx.state !== 'STAGED') return { ctx, effects: [] };
  if (ctx.latest && diverged(ctx, ctx.latest.intent)) return rollback(ctx);
  return ctx.state === 'SPECULATING' ? sendPhase2(ctx) : { ctx, effects: [] };
}

function commit(ctx: SmCtx): Result {
  return {
    ctx: { ...ctx, state: 'COMMITTED', pendingApply: null },
    effects: [{ type: 'commit', turnId: ctx.turnId! }, { type: 'state', state: 'COMMITTED' }, { type: 'warm' }],
  };
}

function onConfirm(ctx: SmCtx, apply: boolean): Result {
  if (ctx.state !== 'SPECULATING' && ctx.state !== 'STAGED') return { ctx, effects: [] };
  if (!apply) return rollback({ ...ctx, noRelock: true });
  return ctx.state === 'STAGED' ? commit(ctx) : { ctx: { ...ctx, pendingApply: true }, effects: [] };
}

// Phase 2 runs on the freshest belief, falling back to the locked one if the latest is 'unknown'.
function sendPhase2(ctx: SmCtx): Result {
  if (ctx.state !== 'SPECULATING' || ctx.phase2Sent) return { ctx, effects: [] };
  const belief = ctx.latest && ctx.latest.intent !== 'unknown' ? ctx.latest : ctx.locked;
  if (!belief) return { ctx, effects: [] };
  return { ctx: { ...ctx, phase2Sent: true }, effects: [{ type: 'phase2', turnId: ctx.turnId!, belief }] };
}

function diverged(ctx: SmCtx, intent: Intent): boolean {
  return ctx.locked !== null && intent !== 'unknown' && intent !== ctx.locked.intent;
}

function rollback(ctx: SmCtx): Result {
  return {
    ctx: { ...ctx, state: 'ROLLED_BACK', locked: null, phase2Sent: false, pendingApply: null },
    effects: [{ type: 'rollback', turnId: ctx.turnId! }, { type: 'state', state: 'ROLLED_BACK' }, { type: 'warm' }],
  };
}

function onBelief(prev: SmCtx, belief: Belief): Result {
  let ctx: SmCtx = { ...prev, latest: belief };
  const effects: Effect[] = [];
  if ((ctx.state === 'SPECULATING' || ctx.state === 'STAGED') && diverged(ctx, belief.intent)) return rollback(ctx);
  if (ctx.state === 'LISTENING') {
    ctx = { ...ctx, state: 'BELIEF_FORMING' };
    effects.push({ type: 'state', state: 'BELIEF_FORMING' });
  }
  if (
    (ctx.state === 'BELIEF_FORMING' || ctx.state === 'ROLLED_BACK') &&
    !ctx.turnEnded &&
    !ctx.noRelock &&
    belief.confidence >= LOCK_CONFIDENCE &&
    SPECULATIVE.includes(belief.intent)
  ) {
    ctx = { ...ctx, state: 'SPECULATING', locked: belief };
    effects.push({ type: 'phase1', turnId: ctx.turnId!, belief }, { type: 'state', state: 'SPECULATING' });
  }
  return { ctx, effects };
}
