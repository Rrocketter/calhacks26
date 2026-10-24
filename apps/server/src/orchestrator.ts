import type { Belief, Claim, ClientEvent, ServerEvent, State } from '@ahead/contracts';
import { SPECULATIVE } from './executor/state-machine.js';
import {
  APPLIED_REPLY,
  DISCARDED_REPLY,
  FALLBACK_REPLY,
  claimForInterject,
  correctBelief,
  correctionAck,
  parseConfirm,
  stagedLine,
  type Answerer,
} from './reply.js';
import type { Speaker } from './voice/session.js';

export interface VoicePort {
  handleClient(ev: ClientEvent): void;
  handleInterject(turnId: string, text: string): void;
  close(): void;
}
export interface TrackerPort {
  onUpdate(turnId: string, text: string): Promise<void>;
  onEagerEnd(turnId: string, text: string): Promise<void>;
  onResume(turnId: string): void;
  onTurnEnd(turnId: string, finalText: string): Promise<Belief>;
}
export interface SpeculatorPort {
  onServerEvent(ev: ServerEvent): void;
  onConfirm(turnId: string, apply: boolean): void;
}
export interface DemoPort {
  start(fixture: string): void;
  stop(): void;
}
export type OrchestratorDeps = {
  send: (ev: ServerEvent) => void;
  voice: VoicePort;
  tracker: TrackerPort | null; // null = mock belief
  speculator: SpeculatorPort;
  speaker: Speaker;
  answerer: Answerer;
  demo: DemoPort | null; // null = live mic
  /** Forward mic audio even with a demo (DEMO_LIVE_INK diagnostics). Default: only without a demo. */
  mic?: boolean;
  today?: () => Date;
  correctionTimeoutMs?: number; // default CORRECTION_TIMEOUT_MS
  confirmWindowMs?: number; // default CONFIRM_WINDOW_MS
};

/** How long an unanswered interject holds the turn's Droid Phase 2. */
export const CORRECTION_TIMEOUT_MS = 4000;
/** How long "Apply?" listens for a spoken yes/no. */
export const CONFIRM_WINDOW_MS = 6000;
/**
 * metric label the HUD reads as "Listening for yes / no". Opening sends
 * `confirm_window:<correction|apply>:<turnId>` with ms > 0 (the HUD's confirm_action target);
 * closing sends `confirm_window` with ms 0.
 */
export const CONFIRM_WINDOW_LABEL = 'confirm_window';
/** A client confirm this soon after a spoken answer settled the same correction lost the race. */
export const FIRST_WINS_MS = 2000;
const DEFAULT_FIXTURE = 'demo-utterance-1';

type Awaiting = { kind: 'correction'; turnId: string; claim: Claim } | { kind: 'apply'; turnId: string } | null;
/** Speculator-bound events of an interjected turn, deferred until the correction resolves. */
type Deferred = { turnId: string; claim: Claim; events: ServerEvent[] };

function turnOf(ev: ServerEvent): string | null {
  return 'turnId' in ev ? ev.turnId : null;
}

/** Routes voice, belief tracker and speculator events for one connection, and decides what to say. */
export class Orchestrator {
  private readonly d: OrchestratorDeps;
  private readonly today: () => Date;
  private readonly correctionTimeoutMs: number;
  private readonly confirmWindowMs: number;
  private closed = false;

  private openTurn: string | null = null;
  /** The open turn's turn_start, kept from the speculator until the turn shows speech (Ink phantoms). */
  private pendingStart: Extract<ServerEvent, { type: 'turn_start' }> | null = null;
  /** Turns whose turn_start went to toSpec; spec-bound events of any other turn are dropped. */
  private readonly started = new Set<string>();
  private readonly lastPartial = new Map<string, string>();
  /** Bumped on turn_resume / turn_end: a delayed eager end for an older generation is dropped. */
  private readonly endGen = new Map<string, number>();
  /** Turns that have shown non-empty text: only a turn's first text can be a spoken confirm. */
  private readonly spoke = new Set<string>();
  private readonly lastBelief = new Map<string, Belief>();
  private readonly specState = new Map<string, State>();
  private lastSpecTurn: string | null = null;
  /** The turn whose turn_start the speculator last received. Older turns were rolled back by it. */
  private specTurn: string | null = null;
  /** Turns whose turn-end reply has run: a later STAGED speaks immediately. */
  private readonly ended = new Set<string>();
  private readonly stagedSpoken = new Set<string>();

  private awaiting: Awaiting = null;
  private held: ServerEvent[] = [];
  private heldTurn: string | null = null;
  /** The staged turn the user confirmed out loud: COMMITTED/ROLLED_BACK speaks for it. */
  private spokenConfirm: string | null = null;
  /** The last turn consumed as a spoken yes/no: its late tracker events are dropped too. */
  private confirmTurn: string | null = null;

  private deferred: Deferred | null = null;
  private readonly corrected = new Map<string, Claim>();
  /** When each turn's correction was settled (by voice, click, key or timeout). */
  private readonly correctionSettled = new Map<string, number>();
  private windowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: OrchestratorDeps) {
    this.d = deps;
    this.today = deps.today ?? (() => new Date());
    this.correctionTimeoutMs = deps.correctionTimeoutMs ?? CORRECTION_TIMEOUT_MS;
    this.confirmWindowMs = deps.confirmWindowMs ?? CONFIRM_WINDOW_MS;
  }

  /** VoiceSession `send`. */
  onVoiceEvent = (ev: ServerEvent): void => {
    const tracker = this.d.tracker;
    switch (ev.type) {
      case 'turn_start':
        if (this.openTurn !== null && this.openTurn !== ev.turnId) this.syntheticEnd(this.openTurn, ev.ts);
        this.openTurn = ev.turnId;
        this.pendingStart = ev;
        this.d.send(ev);
        return;
      case 'transcript_partial':
        this.lastPartial.set(ev.turnId, ev.text);
        this.d.send(ev);
        this.speech(ev.turnId, ev.text);
        if (tracker) this.guard(tracker.onUpdate(ev.turnId, ev.text), 'tracker update');
        return;
      case 'turn_eager_end': {
        this.d.send(ev);
        this.speech(ev.turnId, ev.text);
        if (!tracker) return this.toSpec(ev);
        // Phase 2 fires on eager end with the speculator's latest belief, so let the tracker's
        // belief for the eager text land first (Moss only, about 25 ms; never waits on Haiku).
        const gen = this.endGen.get(ev.turnId) ?? 0;
        const forward = () => {
          if ((this.endGen.get(ev.turnId) ?? 0) === gen) this.toSpec(ev);
        };
        tracker.onEagerEnd(ev.turnId, ev.text).then(forward, (err: unknown) => {
          this.error('orchestrator', `tracker eager end: ${String(err)}`.slice(0, 200));
          forward();
        });
        return;
      }
      case 'turn_resume':
        this.bumpEnd(ev.turnId);
        this.d.send(ev);
        if (tracker) this.safely(() => tracker.onResume(ev.turnId), 'tracker resume');
        this.toSpec(ev);
        return;
      case 'turn_end': {
        this.bumpEnd(ev.turnId);
        if (this.openTurn === ev.turnId) this.openTurn = null;
        this.d.send(ev);
        this.toSpec(ev);
        // An empty final never reaches onVoiceTurnEnd (called synchronously right after this event),
        // so an interjected turn with no awaited answer keeps what was said.
        const turnId = ev.turnId;
        queueMicrotask(() => {
          const waiting = this.awaiting?.kind === 'correction' && this.awaiting.turnId === turnId;
          if (this.deferred?.turnId === turnId && !waiting) this.resolveCorrection(false, false);
        });
        return;
      }
      case 'belief_update':
      case 'moss_hits':
        // Only in mock-belief mode: the mock stream goes through VoiceSession's `send`.
        this.fromBelief(ev);
        return;
      case 'transcript_final':
        this.d.send(ev);
        this.speech(ev.turnId, ev.text);
        return;
      case 'interject':
        // VoiceSession.handleInterject already spoke it; its `send` is the one ws copy.
        this.d.send(ev);
        if (!tracker) this.startCorrection(ev.turnId, ev.text);
        return;
      default:
        this.d.send(ev);
    }
  };

  /** VoiceSession `onTurnEnd`. Called inside the voice event loop: never throws. */
  onVoiceTurnEnd = (turnId: string, finalText: string): void => {
    this.safely(() => this.turnEnd(turnId, finalText), 'turn end');
  };

  /** BeliefTracker `emit`. */
  onTrackerEvent = (ev: ServerEvent): void => {
    if (ev.type === 'belief_update' || ev.type === 'moss_hits') return this.fromBelief(ev);
    if (ev.type === 'interject') {
      this.d.voice.handleInterject(ev.turnId, ev.text);
      this.startCorrection(ev.turnId, ev.text);
      return;
    }
    this.d.send(ev);
  };

  /** Speculator emit and executor emit. */
  onSpeculatorEvent = (ev: ServerEvent): void => {
    this.d.send(ev);
    if (ev.type !== 'state_change' || ev.turnId === '') return;
    this.specState.set(ev.turnId, ev.state);
    this.lastSpecTurn = ev.turnId;
    if (ev.state === 'STAGED' && this.ended.has(ev.turnId) && this.isSpecTurn(ev.turnId)) this.speakStaged(ev.turnId);
    if (ev.state === 'COMMITTED' || ev.state === 'ROLLED_BACK') {
      if (this.awaiting?.kind === 'apply' && this.awaiting.turnId === ev.turnId) this.release();
      if (this.spokenConfirm === ev.turnId) {
        this.spokenConfirm = null;
        this.say(ev.state === 'COMMITTED' ? APPLIED_REPLY : DISCARDED_REPLY, ev.turnId);
      }
    }
  };

  onClient = (ev: ClientEvent): void => {
    switch (ev.type) {
      case 'audio_chunk':
        if (this.d.mic ?? !this.d.demo) this.d.voice.handleClient(ev);
        return;
      case 'confirm_action': {
        // Voice, click and key are equivalent and the first one wins.
        const settledAt = this.correctionSettled.get(ev.turnId);
        const pending = this.deferred?.turnId === ev.turnId || this.awaiting?.turnId === ev.turnId;
        if (!pending && settledAt !== undefined && Date.now() - settledAt < FIRST_WINS_MS) {
          console.log(`[orchestrator] confirm_action ${ev.turnId} ignored: already answered`);
          return;
        }
        if (this.deferred?.turnId === ev.turnId) this.resolveCorrection(ev.apply, false);
        else this.d.speculator.onConfirm(ev.turnId, ev.apply);
        this.release();
        return;
      }
      case 'demo_control': {
        const demo = this.d.demo;
        if (!demo) return this.error('demo', 'demo_control needs DEMO_MODE=1');
        if (ev.action === 'start') demo.start(ev.fixture ?? DEFAULT_FIXTURE);
        else if (ev.action === 'stop') demo.stop();
        else this.error('demo', `demo_control ${ev.action} is not supported`);
        return;
      }
    }
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    this.safely(() => this.d.demo?.stop(), 'demo stop');
    this.safely(() => this.d.voice.close(), 'voice close');
    const t = this.lastSpecTurn;
    const state = t === null ? undefined : this.specState.get(t);
    if (t !== null && (state === 'SPECULATING' || state === 'STAGED')) this.d.speculator.onConfirm(t, false);
  }

  // ---- routing ----

  /** Every speculator-bound event goes through here: correction deferral, then the confirm hold. */
  private toSpec(ev: ServerEvent): void {
    const turnId = turnOf(ev);
    if (turnId !== null && turnId === this.confirmTurn) return; // a spoken yes/no never speculates
    if (ev.type === 'turn_start') this.started.add(ev.turnId);
    else if (turnId !== null && !this.started.has(turnId)) return; // phantom turn: never started
    if (this.deferred && turnId === this.deferred.turnId) {
      this.deferred.events.push(ev);
      return;
    }
    if (this.awaiting && (ev.type === 'turn_start' || (turnId !== null && turnId === this.heldTurn))) {
      if (ev.type === 'turn_start') this.heldTurn = ev.turnId;
      this.held.push(ev);
      return;
    }
    const claim = turnId === null ? undefined : this.corrected.get(turnId);
    if (ev.type === 'belief_update' && claim) {
      const belief = correctBelief(ev.belief, claim, this.today());
      this.lastBelief.set(ev.turnId, belief);
      ev = { ...ev, belief };
    }
    if (ev.type === 'turn_start') this.specTurn = ev.turnId;
    this.d.speculator.onServerEvent(ev);
  }

  /** First real speech of a turn: a pending confirm decides on it, else it forwards the turn_start. */
  private speech(turnId: string, text: string): void {
    if (text.trim() === '') return;
    if (!this.spoke.has(turnId)) {
      this.spoke.add(turnId);
      if (this.fastConfirm(turnId, text)) return;
    }
    const start = this.pendingStart;
    if (!start || start.turnId !== turnId) return;
    // A bare yes/no with nothing pending never starts a turn (it would roll back a staged draft).
    if (parseConfirm(text) !== null) return;
    this.pendingStart = null;
    this.toSpec(start);
  }

  private fromBelief(ev: Extract<ServerEvent, { type: 'belief_update' | 'moss_hits' }>): void {
    const claim = this.corrected.get(ev.turnId);
    if (ev.type === 'belief_update') {
      // The HUD shows the corrected belief once the user accepted a correction.
      if (claim) ev = { ...ev, belief: correctBelief(ev.belief, claim, this.today()) };
      this.lastBelief.set(ev.turnId, ev.belief);
    }
    this.d.send(ev);
    this.toSpec(ev);
  }

  /** A repeated turn_start closes the old turn first, with no spoken reply. */
  private syntheticEnd(old: string, ts: number): void {
    const ev: ServerEvent = { type: 'turn_end', turnId: old, ts };
    this.bumpEnd(old);
    this.openTurn = null;
    if (this.pendingStart?.turnId === old) this.pendingStart = null;
    this.d.send(ev);
    this.toSpec(ev);
    // No longer rolled back by a phantom, it may stage after this: STAGED then speaks.
    if (this.started.has(old)) this.ended.add(old);
    // The user moved on before the turn ended: keep what was said.
    if (this.deferred?.turnId === old) this.resolveCorrection(false, false);
    const tracker = this.d.tracker;
    if (tracker) this.guard(tracker.onTurnEnd(old, this.lastPartial.get(old) ?? ''), 'tracker turn end');
  }

  /**
   * A pending confirm acts on the first text of the next turn: no turn_end, no Haiku, no speech
   * filter. A yes/no is consumed (never speculates); anything else releases the hold.
   */
  private fastConfirm(turnId: string, text: string): boolean {
    const awaiting = this.awaiting;
    if (!awaiting || awaiting.turnId === turnId) return false;
    const apply = parseConfirm(text);
    if (apply === null) {
      this.release();
      return false;
    }
    console.log(`[orchestrator] spoken ${apply ? 'yes' : 'no'} for ${awaiting.kind} ${awaiting.turnId} on ${turnId}`);
    this.confirmTurn = turnId;
    if (this.pendingStart?.turnId === turnId) this.pendingStart = null;
    this.held = this.held.filter((ev) => turnOf(ev) !== turnId);
    if (awaiting.kind === 'correction') {
      this.resolveCorrection(apply, true);
    } else {
      this.spokenConfirm = awaiting.turnId;
      this.d.speculator.onConfirm(awaiting.turnId, apply);
    }
    this.release();
    return true;
  }

  /** Open (with its timeout) or close the confirm window; the HUD shows it from the metric. */
  private setAwaiting(a: Awaiting): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    const wasOpen = this.awaiting !== null;
    this.awaiting = a;
    if (a) {
      const ms = a.kind === 'correction' ? this.correctionTimeoutMs : this.confirmWindowMs;
      this.windowTimer = setTimeout(() => this.onWindowTimeout(a), ms);
      this.windowTimer.unref?.();
      this.d.send({ type: 'metric', source: 'ink', label: `${CONFIRM_WINDOW_LABEL}:${a.kind}:${a.turnId}`, ms });
    } else if (wasOpen) {
      this.d.send({ type: 'metric', source: 'ink', label: CONFIRM_WINDOW_LABEL, ms: 0 });
    }
  }

  private onWindowTimeout(a: Awaiting): void {
    if (this.awaiting !== a) return;
    this.windowTimer = null;
    console.log(`[orchestrator] confirm window closed unanswered (${a!.kind} ${a!.turnId})`);
    this.release();
  }

  /** Flush held events in order and stop awaiting; the speculator's own turn_start rolls back a staged turn. */
  private release(): void {
    if (this.awaiting?.kind === 'correction' && this.deferred?.turnId === this.awaiting.turnId) {
      this.resolveCorrection(false, false);
    }
    this.setAwaiting(null);
    const held = this.held;
    this.held = [];
    this.heldTurn = null;
    for (const ev of held) this.toSpec(ev);
  }

  // ---- turn end ----

  private turnEnd(turnId: string, finalText: string): void {
    const tracker = this.d.tracker;
    const bare = !this.started.has(turnId) && parseConfirm(finalText) !== null;
    if (turnId === this.confirmTurn || bare) {
      // Already acted on at its first partial, or a yes/no with nothing pending: a no-op.
      if (bare && turnId !== this.confirmTurn) console.log(`[orchestrator] bare "${finalText}" with nothing pending ignored (${turnId})`);
      if (tracker) this.guard(tracker.onTurnEnd(turnId, finalText), 'tracker turn end');
      return;
    }
    this.ended.add(turnId);
    const correcting = this.deferred?.turnId === turnId;
    if (correcting) this.setAwaiting({ kind: 'correction', turnId, claim: this.deferred!.claim });
    this.guard(this.reply(turnId, finalText, correcting), 'reply');
  }

  private async reply(turnId: string, finalText: string, correcting: boolean): Promise<void> {
    const tracker = this.d.tracker;
    const belief = tracker ? await tracker.onTurnEnd(turnId, finalText) : this.lastBelief.get(turnId);
    if (correcting || this.closed) return; // the interject already asked a question
    if (belief?.intent === 'lookup') {
      let answer: string;
      try {
        answer = (await this.d.answerer.answer(finalText, belief.topHits)).trim();
        if (!answer) throw new Error('empty answer');
      } catch (err) {
        this.error('llm', `answer failed: ${String(err)}`.slice(0, 200));
        answer = FALLBACK_REPLY;
      }
      this.say(answer, turnId);
      return;
    }
    if (belief && SPECULATIVE.includes(belief.intent)) {
      if (!this.isSpecTurn(turnId)) return; // superseded: the speculator rolled it back, the user moved on
      const state = this.specState.get(turnId);
      if (state === 'SPECULATING') return; // STAGED speaks when it lands
      if (state === 'STAGED') return this.speakStaged(turnId);
    }
    this.say(FALLBACK_REPLY, turnId);
  }

  private isSpecTurn(turnId: string): boolean {
    return this.specTurn === turnId;
  }

  private speakStaged(turnId: string): void {
    if (this.stagedSpoken.has(turnId) || !this.isSpecTurn(turnId)) return;
    this.stagedSpoken.add(turnId);
    const belief = this.lastBelief.get(turnId);
    this.say(belief ? stagedLine(belief) : 'Apply?', turnId);
    this.setAwaiting({ kind: 'apply', turnId });
  }

  // ---- interject correction ----

  private startCorrection(turnId: string, text: string): void {
    if (this.deferred) return;
    const belief = this.lastBelief.get(turnId);
    const claim = belief ? claimForInterject(belief, text) : undefined;
    if (!claim) return;
    this.deferred = { turnId, claim, events: [] };
  }

  /** Flush the deferred turn, corrected on apply. `spoken` acknowledges a spoken yes/no. */
  private resolveCorrection(apply: boolean, spoken: boolean): void {
    const d = this.deferred;
    if (!d) return;
    this.deferred = null;
    this.correctionSettled.set(d.turnId, Date.now());
    if (this.awaiting?.kind === 'correction' && this.awaiting.turnId === d.turnId) this.setAwaiting(null);
    if (apply) this.corrected.set(d.turnId, d.claim);
    console.log(`[orchestrator] correction ${d.turnId} ${apply ? 'applied' : 'kept'} (${d.events.length} deferred)`);
    for (const ev of d.events) this.toSpec(ev);
    const last = this.lastBelief.get(d.turnId);
    if (apply && last) {
      const belief = correctBelief(last, d.claim, this.today());
      this.lastBelief.set(d.turnId, belief);
      this.d.send({ type: 'belief_update', turnId: d.turnId, belief });
    }
    if (spoken) this.say(correctionAck(apply ? d.claim.known : d.claim.said), d.turnId);
  }

  // ---- helpers ----

  private bumpEnd(turnId: string): void {
    this.endGen.set(turnId, (this.endGen.get(turnId) ?? 0) + 1);
  }

  private say(text: string, turnId: string): void {
    if (this.closed) return;
    this.safely(() => void this.d.speaker.speak(text, { interrupt: false, turnId }), 'speak');
  }

  private error(source: string, message: string): void {
    console.error(`[orchestrator] ${source}: ${message}`);
    this.d.send({ type: 'error', source, message });
  }

  private guard(p: Promise<unknown>, label: string): void {
    p.catch((err: unknown) => this.error('orchestrator', `${label}: ${String(err)}`.slice(0, 200)));
  }

  private safely(fn: () => void, label: string): void {
    try {
      fn();
    } catch (err) {
      this.error('orchestrator', `${label}: ${String(err)}`.slice(0, 200));
    }
  }
}
