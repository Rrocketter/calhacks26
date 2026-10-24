import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture } from '@ahead/contracts/mocks/node';
import { fixtureMessages, playFixture } from './fixture-ink.js';
import type { InkMessage } from '../voice/turns.js';

test('demo-utterance-1 maps to Ink messages', () => {
  const msgs = fixtureMessages(loadFixture('demo-utterance-1'));
  assert.deepEqual(msgs[0], { atMs: 0, msg: { type: 'turn.start' } });
  assert.equal(msgs.filter((m) => m.msg.type === 'turn.update').length, 16);
  assert.equal(msgs.filter((m) => m.msg.type === 'turn.eager_end').length, 1);
  const ends = msgs.filter((m) => m.msg.type === 'turn.end');
  assert.equal(ends.length, 1);
  assert.equal(msgs[msgs.length - 1], ends[0]);
  assert.equal(ends[0]!.atMs, 4900);
  assert.ok((ends[0]!.msg.transcript ?? '').length > 20);
});

test('no final entry ends with the last partial text', () => {
  const msgs = fixtureMessages({
    turnId: 'x',
    partials: [
      { atMs: 100, text: 'a' },
      { atMs: 200, text: 'a b' },
      { atMs: 300, text: 'ignored', resume: true },
    ],
  });
  assert.deepEqual(msgs.map((m) => m.msg.type), ['turn.start', 'turn.update', 'turn.update', 'turn.resume', 'turn.end']);
  assert.deepEqual(msgs[4], { atMs: 300, msg: { type: 'turn.end', transcript: 'a b' } });
});

test('playFixture delivers in order', async () => {
  const got: InkMessage[] = [];
  const f = loadFixture('demo-utterance-1');
  await playFixture(f, (m) => got.push(m), { speed: 1000 });
  assert.deepEqual(got, fixtureMessages(f).map((m) => m.msg));
});

test('abort stops delivery', async () => {
  const got: InkMessage[] = [];
  const ac = new AbortController();
  await playFixture(
    loadFixture('demo-utterance-1'),
    (m) => {
      got.push(m);
      ac.abort();
    },
    { speed: 1000, signal: ac.signal },
  );
  assert.equal(got.length, 1);
});
