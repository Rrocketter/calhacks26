import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EstimatedPlaybackClock } from './playback-clock.js';

const R = 24000;

test('idle clock is not muted', () => {
  assert.equal(new EstimatedPlaybackClock().isMuted(0), false);
});

test('mutes for audio plus 300 ms tail', () => {
  const c = new EstimatedPlaybackClock();
  c.onChunk('a', 48000, R, 0);
  assert.equal(c.isMuted(1299), true);
  assert.equal(c.isMuted(1300), false);
});

test('back-to-back chunks queue', () => {
  const c = new EstimatedPlaybackClock();
  c.onChunk('a', 24000, R, 0);
  c.onChunk('a', 24000, R, 100);
  assert.equal(c.isMuted(1299), true);
  assert.equal(c.isMuted(1300), false);
});

test('gaps extend from arrival', () => {
  const c = new EstimatedPlaybackClock();
  c.onChunk('a', 24000, R, 0);
  assert.equal(c.isMuted(799), true);
  assert.equal(c.isMuted(800), false);
  c.onChunk('a', 24000, R, 2000);
  assert.equal(c.isMuted(2799), true);
  assert.equal(c.isMuted(2800), false);
});

test('cancel ends at the ramp', () => {
  const c = new EstimatedPlaybackClock();
  c.onChunk('a', 480000, R, 0);
  c.onCancel('a', 500);
  assert.equal(c.isMuted(829), true);
  assert.equal(c.isMuted(830), false);
});

test('new context replaces the old window', () => {
  const c = new EstimatedPlaybackClock();
  c.onChunk('a', 480000, R, 0);
  c.onChunk('b', 24000, R, 500);
  assert.equal(c.isMuted(1299), true);
  assert.equal(c.isMuted(1300), false);
});

test('done chunk adds nothing', () => {
  const c = new EstimatedPlaybackClock();
  c.onChunk('a', 48000, R, 0);
  c.onChunk('a', 0, R, 100);
  assert.equal(c.isMuted(1299), true);
  assert.equal(c.isMuted(1300), false);
});
