import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Retriever } from '../belief/types.js';
import { SwitchableRetriever } from './cloud-sim.js';

const inner: Retriever = {
  query: async () => ({ hits: [{ docId: 'contact-priya', score: 0.5, snippet: 's', metadata: {} }], latencyMs: 2 }),
};

test('moss mode passes through; cloud-sim waits delayMs first and returns the same hits', async () => {
  const waits: number[] = [];
  const r = new SwitchableRetriever(inner, 300, async (ms) => void waits.push(ms));
  assert.equal(r.mode, 'moss');
  assert.deepEqual(await r.query('priya'), await inner.query('priya'));
  assert.deepEqual(waits, []);
  r.mode = 'cloud-sim';
  const out = await r.query('priya');
  assert.deepEqual(waits, [300]);
  assert.equal(out.hits[0]?.docId, 'contact-priya');
});

test('cloud-sim latency includes the real delay', async () => {
  const r = new SwitchableRetriever(inner, 30);
  r.mode = 'cloud-sim';
  const { latencyMs } = await r.query('priya');
  assert.ok(latencyMs >= 29, String(latencyMs));
});
