import { base64ToBytes } from './base64';

const RAMP_S = 0.03;

/** Gapless PCM playback of s16le chunks, grouped by Sonic context id. */
export class PcmPlayer {
  onFirstAudio?: (contextId: string) => void;

  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private currentContext: string | null = null;
  private stopped = new Set<string>(); // contexts cut by stopNow; their late chunks are dropped

  /** Create and resume the AudioContext; call from a user gesture. */
  prime(): void {
    this.ensure();
  }

  close(): void {
    this.stopNow();
    this.sources.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    ctx?.close().catch(() => {});
  }

  private ensure(): { ctx: AudioContext; gain: GainNode } {
    if (!this.ctx || !this.gain) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return { ctx: this.ctx, gain: this.gain };
  }

  enqueue(contextId: string, pcmBase64: string, sampleRate: number): void {
    if (pcmBase64 === '') return; // the `done` chunk carries no audio
    if (this.stopped.has(contextId)) return;
    const { ctx, gain } = this.ensure();
    const first = contextId !== this.currentContext;
    if (first) {
      const interrupting = this.sources.size > 0;
      this.stopNow();
      this.currentContext = contextId;
      // Let the fade-out finish before the new context starts, or its first 30 ms is attenuated.
      if (interrupting) this.nextStart = ctx.currentTime + RAMP_S + 0.005;
    }
    const bytes = base64ToBytes(pcmBase64);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    if (samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i]! / 32768;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    const startAt = Math.max(ctx.currentTime, this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    if (first) this.onFirstAudio?.(contextId);
  }

  stopNow(): void {
    if (this.currentContext !== null) {
      if (this.stopped.size >= 50) this.stopped.clear();
      this.stopped.add(this.currentContext);
    }
    this.currentContext = null;
    if (!this.ctx || !this.gain) return;
    const t = this.ctx.currentTime;
    const gain = this.gain;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + RAMP_S);
    for (const s of this.sources) {
      try {
        s.stop(t + RAMP_S);
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.nextStart = 0;
    gain.gain.setValueAtTime(1, t + RAMP_S + 0.001); // restore for the next context
  }
}
