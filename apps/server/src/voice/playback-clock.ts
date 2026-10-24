export const PLAYBACK_TAIL_MS = 300;
export const STOP_RAMP_MS = 30; // matches PcmPlayer.stopNow()

export interface PlaybackClock {
  /** A tts_audio_chunk was forwarded to the browser. */
  onChunk(contextId: string, pcmBytes: number, sampleRate: number, now: number): void;
  onCancel(contextId: string, now: number): void;
  /** True while TTS is (estimated) playing, plus the tail. */
  isMuted(now: number): boolean;
  /** Time the mute window ends (-Infinity when idle). */
  mutedUntil(): number;
}

/** Models the browser queue: each buffer is scheduled at max(currentTime, nextStart). */
export class EstimatedPlaybackClock implements PlaybackClock {
  private current: string | null = null;
  private end = -Infinity; // idle: nothing playing, no tail

  constructor(private readonly tailMs: number = PLAYBACK_TAIL_MS) {}

  onChunk(contextId: string, pcmBytes: number, sampleRate: number, now: number): void {
    const durMs = (pcmBytes / 2 / sampleRate) * 1000;
    if (contextId !== this.current) {
      this.current = contextId; // new context: browser stopNow()s the old one
      this.end = now;
    }
    this.end = Math.max(this.end, now) + durMs;
  }

  onCancel(contextId: string, now: number): void {
    if (contextId === this.current) this.end = Math.min(this.end, now + STOP_RAMP_MS);
  }

  isMuted(now: number): boolean {
    return now < this.mutedUntil();
  }

  mutedUntil(): number {
    return this.end + this.tailMs;
  }
}
