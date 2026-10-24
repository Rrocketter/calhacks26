import { useRef, useState } from 'react';
import type { ServerEvent } from '@ahead/contracts';
import { startLive } from './live/session';

interface LogLine {
  id: number;
  text: string;
}

export function App() {
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [partial, setPartial] = useState('');
  const [finals, setFinals] = useState<string[]>([]);
  const [turnId, setTurnId] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [ttfa, setTtfa] = useState<{ client?: number; server?: number }>({});
  const [error, setError] = useState('');
  const stopRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);

  async function start() {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError('');
    const t0 = performance.now();
    let nextId = 0;
    const push = (text: string) =>
      setLog((l) => [...l.slice(-199), { id: nextId++, text: `${text} +${Math.round(performance.now() - t0)}ms` }]);
    const finish = () => {
      stopRef.current = null;
      startingRef.current = false;
      setStarting(false);
      setRunning(false);
    };

    try {
      const transport = await startLive({
        onClientTtfa: (ms) => setTtfa((t) => ({ ...t, client: ms })),
        onClosed: (reason) => {
          push(reason);
          finish();
        },
        onEvent: (e: ServerEvent) => {
          if (e.type !== 'tts_audio_chunk') push(e.type);
          switch (e.type) {
            case 'turn_start':
              setPartial('');
              break;
            case 'transcript_partial':
              setPartial(e.text);
              if (e.text.trim() !== '') setTurnId(e.turnId);
              break;
            case 'transcript_final':
              setFinals((f) => [...f.slice(-49), e.text]);
              setPartial('');
              break;
            case 'turn_end':
              setTurnId(e.turnId);
              setTtfa({});
              break;
            case 'metric':
              if (e.source === 'sonic' && e.label === 'ttfa') setTtfa((t) => ({ ...t, server: Math.round(e.ms) }));
              break;
            case 'error':
              setError(`${e.source ?? 'server'}: ${e.message}`);
              break;
          }
        },
      });
      stopRef.current = transport.stop;
      setRunning(true);
      setStarting(false);
      push('capture started');
    } catch (err) {
      setError((err as Error).message);
      finish();
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>AHEAD</h1>
      <button disabled={starting} onClick={() => (running ? stopRef.current?.() : void start())}>{running ? 'Stop' : 'Start'}</button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <div style={{ margin: '1rem 0', color: '#555' }}>
        {finals.map((t, i) => (
          <div key={i}>{t}</div>
        ))}
      </div>
      <div style={{ fontSize: '2rem', minHeight: '3rem' }}>{partial}</div>
      <p>
        turn: {turnId || '-'} | TTFA client: {ttfa.client ?? '-'} ms | server: {ttfa.server ?? '-'} ms
      </p>
      <pre style={{ height: 200, overflow: 'auto', background: '#f4f4f4', padding: 8, fontSize: 12 }}>
        {log.map((l) => l.text).join('\n')}
      </pre>
    </main>
  );
}
