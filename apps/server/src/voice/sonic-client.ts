import { randomUUID } from 'node:crypto';
import type { ServerEvent } from '@ahead/contracts';
import WebSocket from 'ws';
import { logLatency } from '../log.js';
import type { Speaker } from './session.js';

export const SONIC_MODEL_ID = 'sonic-3.6';
export const SONIC_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
export const SONIC_SAMPLE_RATE = 24000;
const URL = 'wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14';

interface ActiveContext {
  contextId: string;
  turnId: string;
  startedAt: number;
  gotFirst: boolean;
}

export class SonicClient implements Speaker {
  /** Chunks received from Cartesia for contexts that are no longer active (cancelled or finished). */
  droppedChunks = 0;
  private readonly apiKey: string;
  private readonly send: (e: ServerEvent) => void;
  private readonly onCancel?: (contextId: string) => void;
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private active: ActiveContext | null = null;
  private readonly queue: string[] = [];
  private closed = false;

  constructor(opts: {
    apiKey: string;
    send: (e: ServerEvent) => void;
    onCancel?: (contextId: string) => void;
  }) {
    this.apiKey = opts.apiKey;
    this.send = opts.send;
    this.onCancel = opts.onCancel;
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    const t0 = performance.now();
    const ws = new WebSocket(URL, { headers: { 'X-API-Key': this.apiKey } });
    this.ws = ws;
    this.opening = new Promise<void>((resolve) => {
      ws.on('open', () => {
        logLatency('sonic', 'connect', performance.now() - t0);
        this.opening = null;
        for (const m of this.queue.splice(0)) ws.send(m);
        resolve();
      });
      ws.on('error', (err) => {
        console.error(`[sonic] error ${err.message}`);
        this.send({ type: 'error', source: 'sonic', message: err.message });
        // Resolve so callers do not hang; close follows for failed handshakes.
        this.opening = null;
        resolve();
      });
      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = null;
          this.opening = null;
          this.queue.length = 0;
          this.active = null;
        }
      });
      ws.on('message', (data) => this.onMessage(data.toString()));
    });
    return this.opening;
  }

  speak(text: string, opts: { interrupt: boolean; turnId: string }): string {
    const startedAt = performance.now();
    if (this.closed) return randomUUID(); // disposed: never reconnect
    if (opts.interrupt || this.active) this.cancelActive();
    const contextId = randomUUID();
    this.active = { contextId, turnId: opts.turnId, startedAt, gotFirst: false };
    const msg = JSON.stringify({
      model_id: SONIC_MODEL_ID,
      transcript: text,
      voice: SONIC_VOICE_ID,
      language: 'en',
      context_id: contextId,
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SONIC_SAMPLE_RATE },
      continue: false,
    });
    this.write(msg);
    return contextId;
  }

  cancelActive(): string | null {
    const a = this.active;
    if (!a) return null;
    this.active = null;
    this.write(JSON.stringify({ context_id: a.contextId, cancel: true }), false);
    this.onCancel?.(a.contextId);
    return a.contextId;
  }

  close(): void {
    this.closed = true;
    this.active = null;
    this.queue.length = 0;
    this.ws?.close();
    this.ws = null;
    this.opening = null;
  }

  private write(msg: string, queueIfClosed = true): void {
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
      return;
    }
    if (!queueIfClosed) return;
    this.queue.push(msg);
    void this.connect();
  }

  private onMessage(raw: string): void {
    let m: { type?: string; data?: string; context_id?: string; message?: string };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      return;
    }
    const a = this.active;
    if (m.type === 'error') {
      const message = m.message ?? 'unknown sonic error';
      console.error(`[sonic] error ${message}`);
      this.send({ type: 'error', source: 'sonic', message });
      if (a && m.context_id === a.contextId) this.active = null;
      return;
    }
    if (m.type !== 'chunk' && m.type !== 'done') return;
    if (!a || m.context_id !== a.contextId) {
      if (m.type === 'chunk') this.droppedChunks++;
      return;
    }
    if (m.type === 'chunk' && m.data) {
      if (!a.gotFirst) {
        a.gotFirst = true;
        const ms = performance.now() - a.startedAt;
        logLatency('sonic', 'first chunk', ms);
        this.send({ type: 'metric', source: 'sonic', label: 'ttfa', ms });
      }
      this.send({
        type: 'tts_audio_chunk',
        turnId: a.turnId,
        contextId: a.contextId,
        pcm: m.data,
        sampleRate: SONIC_SAMPLE_RATE,
        done: false,
      });
    } else if (m.type === 'done') {
      this.send({
        type: 'tts_audio_chunk',
        turnId: a.turnId,
        contextId: a.contextId,
        pcm: '',
        sampleRate: SONIC_SAMPLE_RATE,
        done: true,
      });
      this.active = null;
    }
  }
}
