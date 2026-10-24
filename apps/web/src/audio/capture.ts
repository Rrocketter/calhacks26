import type { ClientEvent } from '@ahead/contracts';
import { bytesToBase64 } from './base64';

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms

type AudioChunk = Extract<ClientEvent, { type: 'audio_chunk' }>;

/** Starts mic capture at 16 kHz mono and emits 100 ms s16le chunks. Returns stop(). */
export async function startCapture(onChunk: (ev: AudioChunk) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    await ctx.resume();
    await ctx.audioWorklet.addModule('/pcm-capture-worklet.js');
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw err;
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfOutputs: 0 });

  const buf = new Int16Array(CHUNK_SAMPLES);
  let filled = 0;
  let seq = 0;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const f = e.data;
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]!));
      buf[filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (filled === CHUNK_SAMPLES) {
        const pcm = bytesToBase64(new Uint8Array(buf.buffer.slice(0)));
        onChunk({ type: 'audio_chunk', pcm, sampleRate: SAMPLE_RATE, seq: seq++ });
        filled = 0;
      }
    }
  };
  source.connect(node);

  return () => {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}
