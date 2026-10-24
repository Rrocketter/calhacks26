import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { parseClientEvent, type ServerEvent } from '@ahead/contracts';
import { loadFixture } from '@ahead/contracts/mocks/node';
import WebSocket, { WebSocketServer } from 'ws';
import { HaikuIntentLlm } from './belief/haiku.js';
import { BeliefTracker } from './belief/tracker.js';
import { playFixture } from './demo/fixture-ink.js';
import { REPO_ROOT, requireEnv } from './env.js';
import { createDroidExecutor } from './executor/droid-executor.js';
import { Speculator } from './executor/speculator.js';
import type { Emit } from './executor/types.js';
import { MossIndex } from './moss/index.js';
import { Orchestrator, type DemoPort } from './orchestrator.js';
import { HaikuAnswerer } from './reply.js';
import { InkClient } from './voice/ink-client.js';
import { EstimatedPlaybackClock } from './voice/playback-clock.js';
import { VoiceSession, type InkSink } from './voice/session.js';
import { SonicClient } from './voice/sonic-client.js';

const PORT = Number(process.env.AHEAD_SERVER_PORT ?? 8787);
const DEMO_MODE = process.env.DEMO_MODE === '1';
const MOCK_BELIEF = DEMO_MODE && process.env.AHEAD_MOCK_BELIEF === '1';
// Diagnostics: fixtures drive the utterance, real Ink hears the mic (spoken-confirm trials).
const LIVE_INK = !DEMO_MODE || process.env.DEMO_LIVE_INK === '1';

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function main(): Promise<void> {
  if (process.env.AHEAD_MOCK_BELIEF === '1' && !DEMO_MODE) {
    console.log('[server] AHEAD_MOCK_BELIEF ignored without DEMO_MODE=1');
  }
  const apiKey = requireEnv('CARTESIA_API_KEY');

  const contactsFile = path.join(REPO_ROOT, 'workspace-seed', 'contacts.json');
  const { contacts } = JSON.parse(readFileSync(contactsFile, 'utf8')) as { contacts: { name: string }[] };

  // Warm-up before listening: the first utterance must not pay for cold starts.
  const moss = await MossIndex.load();
  await moss.query('warmup');
  const llm = new HaikuIntentLlm();
  await llm.classify({ partial: 'warmup', topHits: [] });
  const answerer = new HaikuAnswerer();

  // One executor per process; each connection points the sink at its own orchestrator.
  let sink: Emit = () => {};
  const executor = createDroidExecutor((ev) => sink(ev));
  await executor.warm(); // logs [droid] createSession

  let active: { ws: WebSocket; teardown: () => void } | null = null;

  const http = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[voice] client connected');
    if (active) {
      // Single-user demo: tear the old connection down synchronously, so its rollback runs on the
      // shared executor before this connection points the sink at its own orchestrator.
      console.log('[server] replacing active connection');
      const prev = active;
      prev.teardown();
      prev.ws.close();
    }

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
    // The callbacks below reference `session` and `orch`, declared later; they only run after both exist.
    const sonic = new SonicClient({
      apiKey,
      send: (e) => session.handleTts(e),
      onCancel: (id) => clock.onCancel(id, Date.now()),
    });
    const inkClient = !LIVE_INK
      ? null
      : new InkClient({
          apiKey,
          onMessage: (m) => session.handleInk(m),
          onError: (message) => send({ type: 'error', source: 'ink', message }),
        });
    const ink: InkSink = inkClient ?? { sendPcm: () => {} };
    const session = new VoiceSession({
      send: (e) => orch.onVoiceEvent(e),
      ink,
      speaker: sonic,
      clock,
      mockBelief: MOCK_BELIEF,
      onTurnEnd: (turnId, finalText) => orch.onVoiceTurnEnd(turnId, finalText),
    });
    const tracker = MOCK_BELIEF
      ? null
      : new BeliefTracker({ retriever: moss, llm, contacts, emit: (e) => orch.onTrackerEvent(e) });
    // Not start()ed: the executor is already warm.
    const speculator = new Speculator(executor, (e) => orch.onSpeculatorEvent(e));

    let fixtureAbort: AbortController | null = null;
    const demo: DemoPort | null = DEMO_MODE
      ? {
          start(name) {
            fixtureAbort?.abort();
            let fixture;
            try {
              fixture = loadFixture(name);
            } catch (err) {
              send({ type: 'error', source: 'demo', message: `bad fixture ${name}: ${errMessage(err)}` });
              return;
            }
            const ac = new AbortController();
            fixtureAbort = ac;
            console.log(`[demo] fixture ${name}`);
            playFixture(fixture, (m) => session.handleInk(m), { signal: ac.signal }).catch((err: unknown) =>
              send({ type: 'error', source: 'demo', message: errMessage(err) }),
            );
          },
          stop() {
            fixtureAbort?.abort();
            fixtureAbort = null;
          },
        }
      : null;

    const orch = new Orchestrator({ send, voice: session, tracker, speculator, speaker: sonic, answerer, demo, mic: LIVE_INK });
    let tornDown = false;
    const teardown = (): void => {
      if (tornDown) return;
      tornDown = true;
      orch.close();
      inkClient?.close();
      sonic.close();
      if (sink === orch.onSpeculatorEvent) sink = () => {};
      if (active?.ws === ws) active = null;
    };
    active = { ws, teardown };
    sink = orch.onSpeculatorEvent;
    void sonic.connect();
    if (inkClient) void inkClient.connect();

    ws.on('message', (data, isBinary) => {
      const ev = isBinary ? null : parseClientEvent(data.toString());
      if (!ev) {
        send({ type: 'error', source: 'voice', message: 'invalid client event' });
        return;
      }
      orch.onClient(ev);
    });
    ws.on('close', () => {
      console.log('[voice] client disconnected');
      teardown();
    });
    ws.on('error', (err) => console.error(`[voice] client socket error ${err.message}`));
  });

  process.once('SIGINT', () => {
    console.log('[server] shutting down');
    void Promise.allSettled([executor.close(), moss.close()]).then(() => process.exit(0));
  });

  // A listen failure (e.g. EADDRINUSE) is a startup failure: release the warmed Droid session first.
  // ws re-emits http server errors on wss, so both need a listener.
  let failed = false;
  const onListenError = (err: Error): void => {
    if (failed) return;
    failed = true;
    console.error(`[server] startup failed ${err.message}`);
    void Promise.allSettled([executor.close(), moss.close()]).then(() => process.exit(1));
  };
  http.once('error', onListenError);
  wss.on('error', onListenError);

  http.listen(PORT, 'localhost', () => {
    const tags = `${DEMO_MODE ? ' DEMO_MODE' : ''}${DEMO_MODE && LIVE_INK ? ' live ink' : ''}${MOCK_BELIEF ? ' mock belief' : ''}`;
    console.log(`[server] listening ws://localhost:${PORT}/ws${tags}`);
  });
}

main().catch((err: unknown) => {
  console.error(`[server] startup failed ${errMessage(err)}`);
  process.exit(1);
});
