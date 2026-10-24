import { useEffect, useReducer, useRef, useState } from 'react';
import { MockSocket } from './mock/socket';
import { startLive } from './live/session';
import type { Transport } from './transport';
import { hudReducer, initialHud, pendingConfirm, type ConfirmTarget } from './hud/state';
import { TopBar } from './hud/TopBar';
import { Transcript } from './hud/Transcript';
import { BeliefPanel } from './hud/BeliefPanel';
import { ExecutorPanel } from './hud/ExecutorPanel';
import { ConfirmCard } from './hud/ConfirmCard';

const params = new URLSearchParams(location.search);
const mode: 'live' | 'mock' = params.get('mock') === '1' ? 'mock' : 'live';
const speed = Number(params.get('speed')) || 1;

export function App() {
  const [hud, dispatch] = useReducer(hudReducer, undefined, initialHud);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const transport = useRef<Transport | null>(null);
  const mock = useRef<MockSocket | null>(null);
  const stopping = useRef(false); // Stop pressed: the close that follows is not an error
  // The confirm target already answered by click or key: the first answer wins, the card hides.
  const [answered, setAnswered] = useState<string | null>(null);

  useEffect(
    () => () => {
      mock.current?.stop();
      transport.current?.stop();
    },
    [],
  );

  // Synchronous on purpose: startLive primes audio before its first await.
  function start() {
    if (starting || running) return;
    setStarting(true);
    setStartError(null);
    stopping.current = false;
    dispatch({ type: 'reset' });
    startLive({
      onEvent: (e) => {
        if (e.type !== 'tts_audio_chunk') dispatch(e);
      },
      onClientTtfa: (ms) => dispatch({ type: 'client_ttfa', ms }),
      onClosed: () => {
        transport.current = null;
        setRunning(false);
        if (!stopping.current) setStartError('connection closed');
      },
    }).then(
      (t) => {
        transport.current = t;
        setStarting(false);
        setRunning(true);
      },
      (err: unknown) => {
        setStartError(err instanceof Error ? err.message : String(err));
        setStarting(false);
      },
    );
  }

  function demo() {
    if (mode === 'live') {
      dispatch({ type: 'reset' });
      transport.current?.send({ type: 'demo_control', action: 'start', fixture: 'demo-utterance-1' });
      return;
    }
    if (!mock.current) {
      mock.current = new MockSocket(dispatch, {
        speed,
        denied: params.get('denied') === '1',
        failed: params.get('failed') === '1',
      });
      transport.current = mock.current;
    }
    dispatch({ type: 'reset' });
    mock.current.play().catch((err: unknown) =>
      dispatch({ type: 'error', source: 'mock', message: String(err) }),
    );
  }

  function confirm(apply: boolean) {
    if (hud.stateTurnId === null) return;
    transport.current?.send({ type: 'confirm_action', turnId: hud.stateTurnId, apply });
  }

  const target = pendingConfirm(hud, mode, running);
  const targetKey = target && `${target.kind}:${target.turnId}`;

  function answer(t: ConfirmTarget, apply: boolean) {
    const key = `${t.kind}:${t.turnId}`;
    if (answered === key) return;
    setAnswered(key);
    transport.current?.send({ type: 'confirm_action', turnId: t.turnId, apply });
  }

  return (
    // data-state drives the ambient hue (LISTENING cool, SPECULATING / STAGED accent, outcome green / red).
    <div className="hud" data-state={hud.state}>
      <TopBar
        hud={hud}
        mode={mode}
        running={running}
        starting={starting}
        onStart={start}
        onStop={() => {
          stopping.current = true;
          transport.current?.stop();
        }}
        onDemo={demo}
      />
      <Transcript hud={hud} error={hud.error ?? startError} />
      <BeliefPanel hud={hud} />
      <ExecutorPanel hud={hud} canSend={running || mode === 'mock'} onConfirm={confirm} />
      {target && targetKey !== answered && (
        <ConfirmCard key={targetKey} hud={hud} target={target} onAnswer={(apply) => answer(target, apply)} />
      )}
    </div>
  );
}
