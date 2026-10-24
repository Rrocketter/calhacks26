import { useRef, useState } from 'react';
import { parseServerEvent, type ClientEvent, type ServerEvent } from '@ahead/contracts';
import { startCapture } from './audio/capture';
import { PcmPlayer } from './audio/playback';

interface LogLine {
  id: number;
  text: string;
}

export function App() {
  const [running, setRunning] = useState(false);
  const [partial, setPartial] = useState('');
  const [finals, setFinals] = useState<string[]>([]);
  const [turnId, setTurnId] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [ttfa, setTtfa] = useState<{ client?: number; server?: number }>({});
  const [error, setError] = useState('');
  const stopRef = useRef<(() => void) | null>(null);

  async function start() {
    setError('');
    const t0 = performance.now();
    const player = new PcmPlayer();
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    let turnEndAt = 0;
    let warned = false;
    let nextId = 0;
    const push = (text: string) =>
      setLog((l) => [...l.slice(-199), { id: nextId++, text: `${text} +${Math.round(performance.now() - t0)}ms` }]);

    player.onFirstAudio = (ctxId) => {
      if (turnEndAt) setTtfa((t) => ({ ...t, client: Math.round(performance.now() - turnEndAt) }));
      push(`first audio ${ctxId.slice(0, 8)}`);
    };

    const onEvent = (e: ServerEvent) => {
      if (e.type !== 'tts_audio_chunk') push(e.type);
      switch (e.type) {
        case 'turn_start':
          setTurnId(e.turnId);
          setPartial('');
          player.stopNow();
          break;
        case 'transcript_partial':
          setPartial(e.text);
          break;
        case 'transcript_final':
          setFinals((f) => [...f, e.text]);
          setPartial('');
          break;
        case 'turn_end':
          turnEndAt = performance.now();
          setTtfa({});
          break;
        case 'tts_audio_chunk':
          player.enqueue(e.contextId, e.pcm, e.sampleRate);
          break;
        case 'metric':
          if (e.source === 'sonic' && e.label === 'ttfa') setTtfa((t) => ({ ...t, server: Math.round(e.ms) }));
          break;
        case 'error':
          setError(`${e.source ?? 'server'}: ${e.message}`);
          break;
      }
    };

    ws.onmessage = (m) => {
      const e = parseServerEvent(String(m.data));
      if (!e) {
        if (!warned) console.warn('ignored unparseable server event');
        warned = true;
        return;
      }
      onEvent(e);
    };
    ws.onclose = () => {
      push('ws closed');
      stopRef.current?.();
      stopRef.current = null;
      setRunning(false);
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('websocket failed'));
    }).catch((err: Error) => setError(err.message));
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      const stopCapture = await startCapture((ev: ClientEvent) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
      });
      stopRef.current = () => {
        stopCapture();
        player.stopNow();
        ws.close();
      };
      setRunning(true);
      push('capture started');
    } catch (err) {
      setError(`mic: ${(err as Error).message}`);
      ws.close();
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>AHEAD</h1>
      <button onClick={() => (running ? stopRef.current?.() : void start())}>{running ? 'Stop' : 'Start'}</button>
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
