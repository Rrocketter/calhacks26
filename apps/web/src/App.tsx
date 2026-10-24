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
    const player = new PcmPlayer();
    player.prime(); // inside the click gesture
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    let turnEndAt = 0;
    let cutTurn = '';
    let stopped = false;
    let stopCapture: (() => void) | null = null;
    let warned = false;
    let nextId = 0;
    const push = (text: string) =>
      setLog((l) => [...l.slice(-199), { id: nextId++, text: `${text} +${Math.round(performance.now() - t0)}ms` }]);

    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopRef.current = null;
      startingRef.current = false;
      setStarting(false);
      stopCapture?.();
      player.close();
      ws.close();
      setRunning(false);
    };
    stopRef.current = stop;

    player.onFirstAudio = (ctxId) => {
      // Reply context = first context whose audio starts after turn_end.
      if (turnEndAt > 0) {
        setTtfa((t) => ({ ...t, client: Math.round(performance.now() - turnEndAt) }));
        turnEndAt = 0;
      }
      push(`first audio ${ctxId.slice(0, 8)}`);
    };

    const onEvent = (e: ServerEvent) => {
      if (e.type !== 'tts_audio_chunk') push(e.type);
      switch (e.type) {
        case 'turn_start':
          // Ink can send a phantom turn_start right after a timeout turn_end; don't touch turnEndAt here.
          setPartial('');
          break;
        case 'transcript_partial':
          setPartial(e.text);
          // Mirror the server: only real speech (first non-empty partial) cuts a reply, once per turn.
          if (e.text.trim() !== '' && cutTurn !== e.turnId) {
            cutTurn = e.turnId;
            setTurnId(e.turnId);
            turnEndAt = 0;
            player.stopNow();
          }
          break;
        case 'transcript_final':
          setFinals((f) => [...f.slice(-49), e.text]);
          setPartial('');
          break;
        case 'turn_end':
          setTurnId(e.turnId);
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
      stop();
    };
    try {
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error('websocket failed'));
      });
    } catch (err) {
      setError((err as Error).message);
      stop();
      return;
    }
    if (stopped) return;

    try {
      const stopFn = await startCapture((ev: ClientEvent) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
      });
      if (stopped || ws.readyState !== WebSocket.OPEN) {
        stopFn();
        stop();
        return;
      }
      stopCapture = stopFn;
      setRunning(true);
      setStarting(false);
      push('capture started');
    } catch (err) {
      setError(`mic: ${(err as Error).message}`);
      stop();
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
