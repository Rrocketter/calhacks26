import WebSocket from 'ws';
import { logLatency } from '../log.js';
import type { InkSink } from './session.js';
import type { InkMessage } from './turns.js';

const URL =
  'wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14';
const MAX_QUEUED_FRAMES = 50; // ~5 s of 100 ms frames while (re)connecting

export class InkClient implements InkSink {
  private readonly apiKey: string;
  private readonly onMessage: (m: InkMessage) => void;
  private readonly onError: (msg: string) => void;
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private readonly queue: Buffer[] = [];
  private lastUpdateAt = 0;
  private closed = false;

  constructor(opts: { apiKey: string; onMessage: (m: InkMessage) => void; onError: (msg: string) => void }) {
    this.apiKey = opts.apiKey;
    this.onMessage = opts.onMessage;
    this.onError = opts.onError;
  }

  connect(): Promise<void> {
    this.closed = false;
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    const t0 = performance.now();
    const ws = new WebSocket(URL, { headers: { 'X-API-Key': this.apiKey } });
    this.ws = ws;
    this.opening = new Promise<void>((resolve) => {
      ws.on('open', () => {
        logLatency('ink', 'connect', performance.now() - t0);
        this.opening = null;
        for (const f of this.queue.splice(0)) ws.send(f);
        resolve();
      });
      ws.on('error', (err) => {
        console.error(`[ink] error ${err.message}`);
        this.onError(err.message);
        this.opening = null;
        resolve(); // close follows; next sendPcm reconnects
      });
      ws.on('close', (code) => {
        if (this.ws !== ws) return;
        console.log(`[ink] closed code=${code}`);
        this.ws = null;
        this.opening = null;
      });
      ws.on('message', (data, isBinary) => {
        if (!isBinary) this.handle(data.toString());
      });
    });
    return this.opening;
  }

  sendPcm(pcm: Buffer): void {
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
      return;
    }
    this.queue.push(pcm);
    if (this.queue.length > MAX_QUEUED_FRAMES) this.queue.shift();
    void this.connect();
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    const ws = this.ws;
    this.ws = null;
    this.opening = null;
    ws?.close();
  }

  private handle(raw: string): void {
    let m: InkMessage;
    try {
      m = JSON.parse(raw) as InkMessage;
    } catch {
      console.error('[ink] unparseable message');
      return;
    }
    const now = performance.now();
    if (m.type === 'turn.start') {
      console.log('[ink] turn.start');
      this.lastUpdateAt = now;
    } else if (m.type === 'turn.update') {
      console.log(`[ink] partial +${Math.round(now - this.lastUpdateAt)}ms`);
      this.lastUpdateAt = now;
    } else if (m.type === 'turn.end') {
      console.log('[ink] turn.end');
    } else if (m.type === 'error') {
      console.error(`[ink] error ${m.title ?? ''} ${m.message ?? ''}`.trimEnd());
    }
    this.onMessage(m);
  }
}
