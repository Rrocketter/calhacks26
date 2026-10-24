import { parseServerEvent, type ClientEvent, type ServerEvent } from '@ahead/contracts';
import { mockBeliefStream, mockDroidRun, mockInkStream, type InkFixture } from '@ahead/contracts/mocks';
import fixture from '@ahead/contracts/mocks/fixtures/demo-utterance-1.json';
import type { Transport } from '../transport';

export type ReplayOpts = { speed?: number; denied?: boolean; failed?: boolean; autoConfirmMs?: number | null };

// Belief timeline starts this long after turn_start so the Thursday interject lands between
// the "Thursday" partial (3000 ms) and "at" (3250 ms).
export const BELIEF_OFFSET_MS = 600;

const SPECULATE_INTENTS = ['reschedule_event', 'draft_message', 'find_file', 'add_note'];

type Run = { id: number; cancel: () => void; cancelled: Promise<void> };

export class MockSocket implements Transport {
  private runId = 0;
  private run: Run | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private staged = false;
  private terminal = false;

  constructor(
    private onEvent: (e: ServerEvent) => void,
    private opts: ReplayOpts = {},
  ) {}

  private get speed() {
    return this.opts.speed ?? 1;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms / this.speed);
      this.timers.add(t);
    });
  }

  private emit(run: Run, e: ServerEvent) {
    if (run.id !== this.runId) return;
    const ok = parseServerEvent(JSON.stringify(e));
    this.onEvent(ok ?? { type: 'error', source: 'mock', message: `invalid mock event ${e.type}` });
  }

  private state(run: Run, turnId: string, state: Extract<ServerEvent, { type: 'state_change' }>['state']) {
    this.emit(run, { type: 'state_change', turnId, state });
  }

  play(): Promise<void> {
    this.stop();
    let cancel!: () => void;
    const cancelled = new Promise<void>((r) => (cancel = r));
    const run: Run = { id: ++this.runId, cancel, cancelled };
    this.run = run;
    this.staged = false;
    this.terminal = false;
    return Promise.race([this.replay(run), cancelled]);
  }

  private async replay(run: Run): Promise<void> {
    const live = () => run.id === this.runId;
    const turnId = (fixture as InkFixture).turnId;
    let eagerDone!: () => void;
    const eager = new Promise<void>((r) => (eagerDone = r));
    let turnEnded = false;
    let autoConfirm: Promise<void> | null = null;
    const tasks: Promise<void>[] = [];

    const maybeAutoConfirm = () => {
      const ms = this.opts.autoConfirmMs ?? null;
      if (ms === null || autoConfirm || !turnEnded || !this.staged) return;
      autoConfirm = this.sleep(ms).then(() => this.finish(run, turnId, true));
    };

    const droid = async () => {
      for await (const e of mockDroidRun(turnId, { withDenied: this.opts.denied })) {
        if (!live()) return;
        let out = e;
        if (e.type === 'droid_event' && (e.kind === 'diff' || e.kind === 'result')) {
          await eager;
          if (!live()) return;
          if (e.kind === 'result' && this.opts.failed) {
            out = { ...e, payload: { ok: false, failed: true, summary: 'droid turn failed after staging' } };
          }
        }
        this.emit(run, out);
        if (e.type === 'droid_event' && e.kind === 'diff') {
          this.state(run, turnId, 'STAGED');
          this.staged = true;
          maybeAutoConfirm();
        }
      }
    };

    const belief = async () => {
      await this.sleep(BELIEF_OFFSET_MS);
      let formed = false;
      let speculating = false;
      for await (const e of mockBeliefStream(turnId, { speed: this.speed })) {
        if (!live()) return;
        this.emit(run, e);
        if (e.type !== 'belief_update') continue;
        if (!formed) {
          formed = true;
          this.state(run, turnId, 'BELIEF_FORMING');
        }
        if (!speculating && e.belief.confidence >= 0.75 && SPECULATE_INTENTS.includes(e.belief.intent)) {
          speculating = true;
          this.state(run, turnId, 'SPECULATING');
          tasks.push(droid());
        }
      }
    };

    for await (const e of mockInkStream(fixture as InkFixture, { speed: this.speed })) {
      if (!live()) return;
      this.emit(run, e);
      if (e.type === 'turn_start') {
        this.state(run, turnId, 'LISTENING');
        tasks.push(belief());
      } else if (e.type === 'turn_eager_end') {
        eagerDone();
      } else if (e.type === 'turn_end') {
        this.emit(run, { type: 'metric', source: 'sonic', label: 'ttfa', ms: 180 });
        turnEnded = true;
        maybeAutoConfirm();
      }
    }
    // Belief may spawn droid late, so drain until no new tasks appear.
    for (let i = 0; i < tasks.length; i++) await tasks[i];
    if (autoConfirm) await autoConfirm;
  }

  private finish(run: Run, turnId: string, apply: boolean) {
    if (run.id !== this.runId || this.terminal || !this.staged) return;
    this.terminal = true;
    this.state(run, turnId, apply ? 'COMMITTED' : 'ROLLED_BACK');
  }

  send(ev: ClientEvent): void {
    if (ev.type === 'confirm_action') {
      if (this.run) this.finish(this.run, ev.turnId, ev.apply);
    } else if (ev.type === 'demo_control') {
      if (ev.action === 'start') void this.play();
      else if (ev.action === 'stop') this.stop();
    }
  }

  stop(): void {
    this.runId++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.run?.cancel();
    this.run = null;
  }
}
