import type { Belief, ServerEvent } from '@ahead/contracts';
import { initial, transition, type Effect, type SmCtx, type SmEvent } from './state-machine.js';
import { SpeculationFailed, type Emit, type Executor } from './types.js';

// Glue: server events -> StateMachine -> Executor calls (never awaited, so a resume can interrupt
// a running phase 2) -> state_change events.
export class Speculator {
  private ctx: SmCtx = initial();
  private lastBelief: Belief | null = null;
  private phase2Seq = 0;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly executor: Executor,
    private readonly emit: Emit,
  ) {}

  start(): void {
    this.track(this.executor.warm(), 'warm');
  }

  onServerEvent(ev: ServerEvent): void {
    if (ev.type === 'turn_start') {
      this.lastBelief = null;
      this.feed({ type: 'turn_start', turnId: ev.turnId });
      return;
    }
    if (ev.type !== 'belief_update' && ev.type !== 'turn_eager_end' && ev.type !== 'turn_resume' && ev.type !== 'turn_end') return;
    if (ev.turnId !== this.ctx.turnId) return;
    switch (ev.type) {
      case 'belief_update':
        this.lastBelief = ev.belief;
        this.feed({ type: 'belief', belief: ev.belief });
        break;
      case 'turn_eager_end':
        this.feed({ type: 'eager_end' });
        break;
      case 'turn_resume':
        this.feed({ type: 'resume' });
        break;
      case 'turn_end':
        this.feed({ type: 'turn_end', belief: this.lastBelief });
        break;
    }
  }

  onConfirm(turnId: string, apply: boolean): void {
    if (turnId !== this.ctx.turnId) return;
    this.feed({ type: 'confirm', apply });
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private feed(ev: SmEvent): void {
    const r = transition(this.ctx, ev);
    this.ctx = r.ctx;
    for (const e of r.effects) this.run(e);
  }

  private run(e: Effect): void {
    const x = this.executor;
    switch (e.type) {
      case 'phase1':
        this.track(x.phase1(e.turnId, e.belief), 'phase1', e.turnId, () => undefined, true);
        break;
      case 'phase2': {
        const seq = ++this.phase2Seq;
        this.track(
          x.phase2(e.turnId, e.belief),
          'phase2',
          e.turnId,
          () => {
            if (seq === this.phase2Seq && this.isCurrent(e.turnId)) this.feed({ type: 'phase2_done' });
          },
          true,
        );
        break;
      }
      case 'reset_phase1':
        this.phase2Seq++; // invalidates any phase2 still in flight
        this.track(x.resetToPhase1(e.turnId), 'resetToPhase1');
        break;
      case 'commit':
        this.track(x.commit(e.turnId), 'commit', e.turnId, () => undefined, true);
        break;
      case 'rollback':
        this.track(x.rollback(e.turnId), 'rollback');
        break;
      case 'warm':
        this.track(x.warm(), 'warm');
        break;
      case 'state':
        this.emit({ type: 'state_change', turnId: this.ctx.turnId ?? '', state: e.state });
        break;
    }
  }

  private isCurrent(turnId: string): boolean {
    return this.ctx.turnId === turnId;
  }

  // Every executor promise gets a catch. `feedsFailure` calls also drive the machine to `failed`.
  private track(p: Promise<void>, label: string, turnId?: string, onOk: () => void = () => undefined, feedsFailure = false): void {
    const done: Promise<void> = p
      .then(onOk)
      .catch((err: unknown) => {
        if (!(err instanceof SpeculationFailed)) {
          const msg = err instanceof Error ? err.message : String(err);
          this.emit({ type: 'error', source: 'droid', message: `${label}: ${msg}`.slice(0, 200) });
        }
        if (feedsFailure && turnId !== undefined && this.isCurrent(turnId)) this.feed({ type: 'failed' });
      })
      .finally(() => void this.pending.delete(done));
    this.pending.add(done);
  }
}
