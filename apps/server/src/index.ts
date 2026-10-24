import { createServer } from 'node:http';
import { parseClientEvent, type ServerEvent } from '@ahead/contracts';
import WebSocket, { WebSocketServer } from 'ws';
import { requireEnv } from './env.js';
import { InkClient } from './voice/ink-client.js';
import { EstimatedPlaybackClock } from './voice/playback-clock.js';
import { VoiceSession } from './voice/session.js';
import { SonicClient } from './voice/sonic-client.js';

const PORT = Number(process.env.PORT ?? 8787);
const MOCK_BELIEF = process.env.AHEAD_MOCK_BELIEF === '1';
const apiKey = requireEnv('CARTESIA_API_KEY');

const http = createServer((_req, res) => {
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('[voice] client connected');
  // Never throws: session.ts calls send from promise catch handlers.
  const send = (e: ServerEvent): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(e));
    } catch (err) {
      console.error(`[voice] send failed ${String(err)}`);
    }
  };

  const clock = new EstimatedPlaybackClock();
  // The clients' callbacks reference `session`, declared below; they only run after it exists.
  const sonic = new SonicClient({
    apiKey,
    send: (e) => session.handleTts(e),
    onCancel: (id) => clock.onCancel(id, Date.now()),
  });
  const ink = new InkClient({
    apiKey,
    onMessage: (m) => session.handleInk(m),
    onError: (message) => send({ type: 'error', source: 'ink', message }),
  });
  const session = new VoiceSession({ send, ink, speaker: sonic, clock, mockBelief: MOCK_BELIEF });
  void sonic.connect();
  void ink.connect();

  ws.on('message', (data, isBinary) => {
    const ev = isBinary ? null : parseClientEvent(data.toString());
    if (!ev) {
      send({ type: 'error', source: 'voice', message: 'invalid client event' });
      return;
    }
    session.handleClient(ev);
  });
  ws.on('close', () => {
    console.log('[voice] client disconnected');
    ink.close();
    sonic.close();
  });
  ws.on('error', (err) => console.error(`[voice] client socket error ${err.message}`));
});

http.listen(PORT, () => {
  console.log(`[voice] listening ws://localhost:${PORT}/ws${MOCK_BELIEF ? ' (AHEAD_MOCK_BELIEF=1)' : ''}`);
});
