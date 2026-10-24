import { parseServerEvent, type ClientEvent, type ServerEvent } from '@ahead/contracts';
import { startCapture } from '../audio/capture';
import { PcmPlayer } from '../audio/playback';
import type { Transport } from '../transport';

export type LiveHandlers = {
  onEvent(e: ServerEvent): void; // every parsed server event, including tts_audio_chunk
  onClientTtfa(ms: number): void;
  // Fires once, only after startLive resolved (socket closed, including via stop()).
  // Startup failures reject instead and never fire onClosed, so callers don't double-handle.
  onClosed(reason: string): void;
};

export async function startLive(h: LiveHandlers): Promise<Transport> {
  const player = new PcmPlayer();
  player.prime(); // inside the click gesture: must run before the first await
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let turnEndAt = 0;
  let cutTurn = '';
  let stopped = false;
  let ready = false;
  let closedFired = false;
  let stopCapture: (() => void) | null = null;
  let warned = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopCapture?.();
    player.close();
    ws.close();
  };

  player.onFirstAudio = () => {
    // Reply context = first context whose audio starts after turn_end.
    if (turnEndAt > 0) {
      h.onClientTtfa(Math.round(performance.now() - turnEndAt));
      turnEndAt = 0;
    }
  };

  ws.onmessage = (m) => {
    const e = parseServerEvent(String(m.data));
    if (!e) {
      if (!warned) console.warn('ignored unparseable server event');
      warned = true;
      return;
    }
    switch (e.type) {
      case 'transcript_partial':
        // Mirror the server: only real speech (first non-empty partial) cuts a reply, once per turn.
        if (e.text.trim() !== '' && cutTurn !== e.turnId) {
          cutTurn = e.turnId;
          turnEndAt = 0;
          player.stopNow();
        }
        break;
      case 'turn_end':
        turnEndAt = performance.now();
        break;
      case 'tts_audio_chunk':
        player.enqueue(e.contextId, e.pcm, e.sampleRate);
        break;
      // turn_start: Ink can send a phantom one right after a timeout turn_end; don't touch turnEndAt.
    }
    h.onEvent(e);
  };
  ws.onclose = () => {
    stop();
    if (ready && !closedFired) {
      closedFired = true;
      h.onClosed('ws closed');
    }
  };

  try {
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('websocket failed'));
    });
  } catch (err) {
    stop();
    throw err;
  }
  if (stopped) throw new Error('websocket closed');

  let stopFn: () => void;
  try {
    stopFn = await startCapture((ev: ClientEvent) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
    });
  } catch (err) {
    stop();
    throw new Error(`mic: ${(err as Error).message}`, { cause: err });
  }
  if (stopped || ws.readyState !== WebSocket.OPEN) {
    stopFn();
    stop();
    throw new Error('websocket closed');
  }
  stopCapture = stopFn;
  ready = true;

  return {
    send(ev) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
    },
    stop,
  };
}
