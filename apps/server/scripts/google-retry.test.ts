import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, isQuotaError, withRetry } from './google-retry.js';

const quota = Object.assign(new Error('Quota exceeded for quota metric ... Units per minute per user'), { status: 429 });

test('isQuotaError: 429, 403 rate-limit reasons, quota message; not other errors', () => {
  assert.equal(isQuotaError(quota), true);
  assert.equal(isQuotaError({ status: 403, errors: [{ reason: 'userRateLimitExceeded' }] }), true);
  assert.equal(isQuotaError({ response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } }), true);
  assert.equal(isQuotaError(new Error('Quota exceeded for quota metric')), true);
  assert.equal(isQuotaError({ status: 403, errors: [{ reason: 'insufficientPermissions' }] }), false);
  assert.equal(isQuotaError({ status: 404 }), false);
  assert.equal(isQuotaError(new Error('boom')), false);
});

test('backoffMs: exponential with jitter, capped, honors Retry-After', () => {
  assert.equal(backoffMs(1, undefined, () => 0), 1000);
  assert.equal(backoffMs(3, undefined, () => 0), 4000);
  assert.equal(backoffMs(3, undefined, () => 0.999) < 5000, true);
  assert.equal(backoffMs(20, undefined, () => 0), 32000);
  assert.equal(backoffMs(1, { response: { headers: { 'retry-after': '7' } } }, () => 0), 7000);
});

test('withRetry: retries quota errors, then succeeds', async () => {
  const waits: number[] = [];
  let calls = 0;
  const out = await withRetry(
    async () => {
      if (++calls < 3) throw quota;
      return 'ok';
    },
    { sleep: async (ms) => void waits.push(ms), rand: () => 0, log: () => {} },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('withRetry: non-quota errors throw at once; gives up after max tries', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error('boom');
    }, { sleep: async () => {}, log: () => {} }),
    /boom/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw quota;
    }, { tries: 4, sleep: async () => {}, log: () => {} }),
    /Quota exceeded/,
  );
  assert.equal(calls, 4);
});
