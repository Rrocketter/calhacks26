import type { ClientEvent, ServerEvent } from '@ahead/contracts';
import { mockBeliefStream } from '@ahead/contracts/mocks';
import { EstimatedPlaybackClock, type PlaybackClock } from './playback-clock.js';
import { TurnTracker, type InkMessage } from './turns.js';

export interface InkSink {
  sendPcm(pcm: Buffer): void;
}

export interface Speaker {
  /** Returns the contextId of the reply. */
  speak(text: string, opts: { interrupt: boolean; turnId: string }): string;
  /** Returns the cancelled contextId, null if none was active. */
  cancelActive(): string | null;
}

export const TURN_END_REPLY = 'Got it, I heard you.';

export class VoiceSession {
  private readonly send: (e: ServerEvent) => void;
  private readonly ink: InkSink;
  private readonly speaker: Speaker;
  private readonly clock: PlaybackClock;
  private readonly now: () => number;
  private readonly mockBelief: boolean;
  private readonly mockSpeed: number;
  private readonly tracker = new TurnTracker();
  private badRateReported = false;
  private interjectedTurn: string | null = null;
  /** Mic frames dropped during the current mute window. */
  droppedFrames = 0;
  private loggedMuteUntil = -Infinity;

  constructor(deps: {
    send: (e: ServerEvent) => void;
    ink: InkSink;
    speaker: Speaker;
    clock?: PlaybackClock;
    now?: () => number;
    mockBelief?: boolean;
    mockSpeed?: number;
  }) {
    this.send = deps.send;
    this.ink = deps.ink;
    this.speaker = deps.speaker;
    this.clock = deps.clock ?? new EstimatedPlaybackClock();
    this.now = deps.now ?? Date.now;
    this.mockBelief = deps.mockBelief ?? false;
    this.mockSpeed = deps.mockSpeed ?? 1;
  }

  handleClient(ev: ClientEvent): void {
    if (ev.type !== 'audio_chunk') return;
    if (ev.sampleRate !== 16000) {
      if (!this.badRateReported) {
        this.badRateReported = true;
        this.send({
          type: 'error',
          message: `expected 16000 Hz mic audio, got ${ev.sampleRate}`,
          source: 'voice',
        });
      }
      return;
    }
    if (this.clock.isMuted(this.now())) {
      this.droppedFrames++; // drop, never send zeros
      return;
    }
    if (this.droppedFrames > 0) {
      console.log(`[voice] dropped ${this.droppedFrames} mic frames`);
      this.droppedFrames = 0;
    }
    this.ink.sendPcm(Buffer.from(ev.pcm, 'base64'));
  }

  handleTts(ev: ServerEvent): void {
    if (ev.type === 'tts_audio_chunk') {
      const now = this.now();
      this.clock.onChunk(ev.contextId, Buffer.byteLength(ev.pcm, 'base64'), ev.sampleRate, now);
      // Log once per reply (on done) rather than on every chunk extension.
      const until = this.clock.mutedUntil();
      if (ev.done && until > this.loggedMuteUntil) {
        this.loggedMuteUntil = until;
        console.log(`[voice] mute until +${Math.round(until - now)}ms`);
      }
    }
    this.send(ev);
  }

  handleInk(msg: InkMessage): void {
    for (const ev of this.tracker.handle(msg, this.now())) {
      this.send(ev);
      if (ev.type === 'turn_start') {
        const cancelled = this.speaker.cancelActive();
        if (cancelled !== null) this.clock.onCancel(cancelled, this.now());
        if (this.mockBelief) {
          this.runMockBelief(ev.turnId).catch((err: unknown) => {
            console.error(`[voice] mock belief error ${String(err)}`);
            this.send({ type: 'error', message: String(err), source: 'voice' });
          });
        }
      } else if (ev.type === 'turn_end') {
        this.speaker.speak(TURN_END_REPLY, { interrupt: false, turnId: ev.turnId });
      }
    }
  }

  handleInterject(turnId: string, text: string): void {
    if (turnId !== this.tracker.turnId) return;
    if (this.interjectedTurn === turnId) return;
    this.interjectedTurn = turnId;
    this.send({ type: 'interject', turnId, text });
    this.speaker.speak(text, { interrupt: true, turnId });
  }

  private async runMockBelief(turnId: string): Promise<void> {
    for await (const ev of mockBeliefStream(turnId, { speed: this.mockSpeed })) {
      if (this.tracker.turnId !== turnId) return;
      if (ev.type === 'interject') this.handleInterject(turnId, ev.text);
      else this.send(ev);
    }
  }
}
