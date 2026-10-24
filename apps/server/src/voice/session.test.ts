import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_INTERJECTION } from '@ahead/contracts/mocks';
import type { ClientEvent, ServerEvent } from '@ahead/contracts';
import { EstimatedPlaybackClock } from './playback-clock.js';
import { TURN_END_REPLY, VoiceSession, type Speaker } from './session.js';

type SpeakCall = { text: string; opts: { interrupt: boolean; turnId: string }; id: string };

function setup(extra: { mockBelief?: boolean; mockSpeed?: number; useRealClock?: boolean } = {}) {
  const sent: ServerEvent[] = [];
  const pcm: Buffer[] = [];
  const speaks: SpeakCall[] = [];
  const cancels: Array<string | null> = [];
  let now = 0;
  const speaker: Speaker = {
    speak(text, opts) {
      const id = 'c' + speaks.length;
      speaks.push({ text, opts, id });
      return id;
    },
    cancelActive() {
      const id = speaks.at(-1)?.id ?? null;
      cancels.push(id);
      return id;
    },
  };
  const session = new VoiceSession({
    send: (e) => sent.push(e),
    ink: { sendPcm: (b) => pcm.push(b) },
    speaker,
    clock: new EstimatedPlaybackClock(),
    now: extra.useRealClock ? Date.now : () => now,
    mockBelief: extra.mockBelief,
    mockSpeed: extra.mockSpeed,
  });
  return { session, sent, pcm, speaks, cancels, setNow: (t: number) => (now = t) };
}

const audio = (sampleRate: number, b64 = Buffer.from([1, 2, 3, 4]).toString('base64')): ClientEvent =>
  ({ type: 'audio_chunk', pcm: b64, sampleRate, seq: 0 });

const ttsChunk = (contextId: string, bytes: number): ServerEvent =>
  ({
    type: 'tts_audio_chunk',
    turnId: 't',
    contextId,
    pcm: Buffer.alloc(bytes).toString('base64'),
    sampleRate: 24000,
    done: false,
  });

function startedTurnId(sent: ServerEvent[]): string {
  const e = sent.find((x) => x.type === 'turn_start');
  assert.ok(e && e.type === 'turn_start');
  return e.turnId;
}

test('forwards audio when open', () => {
  const { session, pcm } = setup();
  session.handleClient(audio(16000));
  assert.equal(pcm.length, 1);
  assert.deepEqual([...pcm[0]!], [1, 2, 3, 4]);
});

test('rejects wrong sample rate', () => {
  const { session, pcm, sent } = setup();
  session.handleClient(audio(48000));
  session.handleClient(audio(48000));
  assert.equal(pcm.length, 0);
  const errors = sent.filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.type === 'error' && errors[0].source, 'voice');
  assert.match(errors[0]?.type === 'error' ? errors[0].message : '', /48000/);
});

test('turn end speaks the canned reply', () => {
  const { session, sent, speaks } = setup();
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.update', transcript: 'hi' });
  session.handleInk({ type: 'turn.end', transcript: 'hi' });
  assert.equal(speaks.length, 1);
  assert.equal(speaks[0]?.text, TURN_END_REPLY);
  assert.deepEqual(speaks[0]?.opts, { interrupt: false, turnId: startedTurnId(sent) });
});

test('mic is dropped while TTS plays', () => {
  const { session, sent, pcm, setNow } = setup();
  const chunk = ttsChunk('c0', 48000);
  session.handleTts(chunk);
  assert.deepEqual(sent, [chunk]);
  setNow(1299);
  session.handleClient(audio(16000));
  assert.equal(pcm.length, 0);
  setNow(1300);
  session.handleClient(audio(16000));
  assert.equal(pcm.length, 1);
});

test('interject speaks with interrupt', () => {
  const { session, sent, speaks } = setup();
  session.handleInk({ type: 'turn.start' });
  const id = startedTurnId(sent);
  session.handleInterject(id, 'x');
  assert.ok(sent.some((e) => e.type === 'interject' && e.text === 'x' && e.turnId === id));
  assert.deepEqual(speaks[0]?.opts, { interrupt: true, turnId: id });
  assert.equal(speaks[0]?.text, 'x');
});

test('interject for an ended turn is ignored', () => {
  const { session, sent, speaks, pcm } = setup();
  session.handleInk({ type: 'turn.start' });
  const id = startedTurnId(sent);
  session.handleInk({ type: 'turn.end', transcript: 'a' });
  const before = speaks.length;
  session.handleInterject(id, 'x');
  assert.equal(speaks.length, before);
  assert.equal(sent.filter((e) => e.type === 'interject').length, 0);
  session.handleClient(audio(16000));
  assert.equal(pcm.length, 1);
});

test('one interjection per turn', () => {
  const { session, sent, speaks } = setup();
  session.handleInk({ type: 'turn.start' });
  const id = startedTurnId(sent);
  session.handleInterject(id, 'x');
  session.handleInterject(id, 'y');
  assert.equal(speaks.filter((s) => s.opts.interrupt).length, 1);
  assert.equal(sent.filter((e) => e.type === 'interject').length, 1);
});

test('new turn cancels the active reply', () => {
  const { session, cancels } = setup();
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.end', transcript: 'a' });
  const before = cancels.length;
  session.handleInk({ type: 'turn.start' });
  assert.equal(cancels.length, before + 1);
});

test('mock belief drives the interject path', async () => {
  const { session, sent, speaks } = setup({ mockBelief: true, mockSpeed: 50, useRealClock: true });
  session.handleInk({ type: 'turn.start' });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(sent.some((e) => e.type === 'moss_hits'));
  assert.ok(sent.some((e) => e.type === 'belief_update'));
  const interjects = sent.filter((e) => e.type === 'interject');
  assert.equal(interjects.length, 1);
  assert.equal(interjects[0]?.type === 'interject' && interjects[0].text, DEMO_INTERJECTION);
  assert.ok(speaks.some((s) => s.opts.interrupt));
});
