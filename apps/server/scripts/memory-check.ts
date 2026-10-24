// Conversation-memory check against a running DEMO_MODE server: plays a lookup fixture and passes
// when the turn's final belief is a lookup whose Moss hits include a committed-artifact memory doc
// naming the person. Run after `demo:run demo-utterance-1` committed a draft.
// Usage: memory-check.ts [fixture] [--person=priya] [--port=N]
import { parseServerEvent, type Belief, type ClientEvent } from '@ahead/contracts';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const fixture = args.find((a) => !a.startsWith('--')) ?? 'demo-lookup-priya';
const person = (flag('person') ?? 'priya').toLowerCase();
const PORT = Number(flag('port') ?? process.env.AHEAD_SERVER_PORT ?? 8787);
const TIMEOUT_MS = 30000;
const TTS_SETTLE_MS = 1500;

const t0 = performance.now();
const since = () => Math.round(performance.now() - t0);
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const send = (e: ClientEvent) => ws.send(JSON.stringify(e));

let turn: string | null = null;
let last: Belief | null = null;
let firstMemoryAt: number | null = null;
let endedAt: number | null = null;
let ttsDone = false;

const done = new Promise<void>((resolve) => {
  const guard = setTimeout(resolve, TIMEOUT_MS);
  ws.on('open', () => send({ type: 'demo_control', action: 'start', fixture }));
  ws.on('message', (raw) => {
    const ev = parseServerEvent(raw.toString());
    if (!ev) return;
    if (ev.type === 'turn_start' && !turn) turn = ev.turnId;
    if (!turn || !('turnId' in ev) || ev.turnId !== turn) return;
    if (ev.type === 'belief_update') {
      last = ev.belief;
      if (firstMemoryAt === null && ev.belief.topHits.some((h) => h.docId.startsWith('memory-'))) firstMemoryAt = since();
    } else if (ev.type === 'turn_end') {
      endedAt = since();
    } else if (ev.type === 'tts_audio_chunk' && ev.done) {
      ttsDone = true;
      clearTimeout(guard);
      setTimeout(resolve, TTS_SETTLE_MS); // let the final belief land
    }
  });
  ws.on('error', (err) => {
    console.log(`ws error ${err.message}`);
    resolve();
  });
});

await done;
ws.close();
const b = last as Belief | null;
const memoryHits = (b?.topHits ?? []).filter((h) => h.docId.startsWith('memory-'));
const artifact = memoryHits.find((h) => h.docId.endsWith('-artifact') && h.snippet.toLowerCase().includes(person));
console.log(`turn ${turn} ended +${endedAt}ms, reply audio ${ttsDone ? 'done' : 'missing'}`);
console.log(`final intent ${b?.intent} confidence ${b?.confidence}`);
console.log(`first belief with a memory hit +${firstMemoryAt}ms`);
for (const h of b?.topHits ?? []) console.log(`  ${h.docId.startsWith('memory-') ? '[memory] ' : ''}${h.docId} ${h.score.toFixed(3)} ${h.snippet.slice(0, 120)}`);
const ok = b?.intent === 'lookup' && !!artifact && ttsDone;
console.log(ok ? `PASS: lookup retrieved ${artifact.docId}` : 'FAIL: no committed-artifact memory hit in the lookup belief');
process.exit(ok ? 0 : 1);
