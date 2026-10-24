import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerEventSchema, type ServerEvent } from '@ahead/contracts';
import { TurnTracker, type InkMessage } from './turns.js';

function makeTracker(): TurnTracker {
  let n = 0;
  return new TurnTracker(() => 't' + n++);
}

function run(tracker: TurnTracker, msgs: InkMessage[]): ServerEvent[] {
  return msgs.flatMap((m, i) => tracker.handle(m, 100 + i));
}

const fullTurn: InkMessage[] = [
  { type: 'turn.start' },
  { type: 'turn.update', transcript: 'Draft a' },
  { type: 'turn.eager_end', transcript: 'Draft a message.' },
  { type: 'turn.end', transcript: 'Draft a message.' },
];

test('maps a full turn', () => {
  const tracker = makeTracker();
  const events = run(tracker, fullTurn);
  assert.deepEqual(
    events.map((e) => e.type),
    ['turn_start', 'transcript_partial', 'turn_eager_end', 'transcript_final', 'turn_end'],
  );
  for (const e of events) assert.equal('turnId' in e && e.turnId, 't0');
  const final = events.find((e) => e.type === 'transcript_final');
  assert.equal(final?.type === 'transcript_final' && final.text, 'Draft a message.');
  assert.equal(tracker.turnId, null);
});

test('resume keeps the same id', () => {
  const tracker = makeTracker();
  const events = run(tracker, [
    { type: 'turn.start' },
    { type: 'turn.eager_end', transcript: 'ok' },
    { type: 'turn.resume' },
    { type: 'turn.update', transcript: 'ok then' },
    { type: 'turn.end', transcript: 'ok then' },
  ]);
  for (const e of events) assert.equal('turnId' in e && e.turnId, 't0');
  const next = tracker.handle({ type: 'turn.start' }, 200);
  assert.equal(next[0]?.type === 'turn_start' && next[0].turnId, 't1');
});

test('update without start opens a turn', () => {
  const tracker = makeTracker();
  const events = tracker.handle({ type: 'turn.update', transcript: 'hi' }, 5);
  assert.deepEqual(events, [
    { type: 'turn_start', turnId: 't0', ts: 5 },
    { type: 'transcript_partial', turnId: 't0', text: 'hi', ts: 5 },
  ]);
});

test('stale resume and end are ignored', () => {
  const tracker = makeTracker();
  assert.deepEqual(tracker.handle({ type: 'turn.resume' }, 1), []);
  assert.deepEqual(tracker.handle({ type: 'turn.end', transcript: 'x' }, 2), []);
});

test('every emitted event passes ServerEventSchema', () => {
  const tracker = makeTracker();
  const events = run(tracker, [
    ...fullTurn,
    { type: 'error', title: 'Bad', message: 'thing' },
  ]);
  const err = events.at(-1);
  assert.deepEqual(err, { type: 'error', message: 'Bad thing', source: 'ink' });
  for (const e of events) assert.equal(ServerEventSchema.safeParse(e).success, true);
});

test('ignores connected', () => {
  assert.deepEqual(makeTracker().handle({ type: 'connected' }, 1), []);
});
