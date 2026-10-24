import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_INTERJECTION } from '@ahead/contracts/mocks';
import type { ClientEvent, ServerEvent } from '@ahead/contracts';
import { EstimatedPlaybackClock } from './playback-clock.js';
import { TURN_END_REPLY, VoiceSession, type Speaker } from './session.js';

type SpeakCall = { text: string; opts: { interrupt: boolean; turnId: string }; id: string };

function setup(
  extra: {
    mockBelief?: boolean;
    mockSpeed?: number;
    useRealClock?: boolean;
    onTurnEnd?: (turnId: string, finalText: string) => void;
  } = {},
) {
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
    onTurnEnd: extra.onTurnEnd,
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

test('turn_end with onTurnEnd set calls it with the final text and speaks nothing', () => {
  const calls: Array<[string, string]> = [];
  const { session, sent, speaks } = setup({ onTurnEnd: (id, text) => calls.push([id, text]) });
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.update', transcript: 'hi there' });
  session.handleInk({ type: 'turn.end', transcript: 'hi there' });
  assert.deepEqual(calls, [[startedTurnId(sent), 'hi there']]);
  assert.equal(speaks.length, 0);
});

test('turn_end with onTurnEnd set and empty final calls nothing', () => {
  const calls: Array<[string, string]> = [];
  const { session, speaks } = setup({ onTurnEnd: (id, text) => calls.push([id, text]) });
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.end', transcript: '' });
  assert.equal(calls.length, 0);
  assert.equal(speaks.length, 0);
});

test('mic is dropped while TTS plays', () => {
  const { session, sent, pcm, setNow } = setup();
  const chunk = ttsChunk('c0', 48000);
  session.handleTts(chunk);
  assert.deepEqual(sent, [chunk]);
  setNow(1099);
  session.handleClient(audio(16000));
  assert.equal(pcm.length, 0);
  setNow(1100);
  session.handleClient(audio(16000));
  assert.equal(pcm.length, 1);
});

test('interject speaks with interrupt', () => {
  const { session, sent, speaks } = setup();
  session.handleInk({ type: 'turn.start' });
  const id = startedTurnId(sent);
  session.handleInterject(id, 'x');
  assert.ok(sent.some((e) => e.type === 'interject' && e.text === 'x' && e.turnId === id));
  assert.ok(sent.some((e) => e.type === 'assistant_reply' && e.kind === 'interject' && e.text === 'x' && e.turnId === id));
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

test('new turn cancels the active reply on its first non-empty partial', () => {
  const { session, cancels } = setup();
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.update', transcript: 'a' });
  session.handleInk({ type: 'turn.end', transcript: 'a' });
  const before = cancels.length;
  session.handleInk({ type: 'turn.start' });
  assert.equal(cancels.length, before);
  session.handleInk({ type: 'turn.update', transcript: 'b' });
  assert.equal(cancels.length, before + 1);
});

test('a bare turn.start does not cancel or start mock belief', async () => {
  const { session, sent, cancels } = setup({ mockBelief: true, mockSpeed: 50, useRealClock: true });
  session.handleInk({ type: 'turn.start' });
  assert.equal(cancels.length, 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    sent.map((e) => e.type),
    ['turn_start'],
  );
});

test('only the first non-empty partial cancels', () => {
  const { session, cancels } = setup();
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.update', transcript: '  ' });
  assert.equal(cancels.length, 0);
  session.handleInk({ type: 'turn.update', transcript: 'hi' });
  session.handleInk({ type: 'turn.update', transcript: 'hi there' });
  assert.equal(cancels.length, 1);
});

test('turn that ends with an empty transcript does not speak', () => {
  const { session, sent, speaks } = setup();
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.end', transcript: ' ' });
  assert.equal(speaks.length, 0);
  assert.deepEqual(
    sent.map((e) => e.type),
    ['turn_start', 'transcript_final', 'turn_end'],
  );
});

test('closed session ignores Ink, client, interject and TTS events', () => {
  const { session, sent, speaks, pcm } = setup();
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.update', transcript: 'hi' });
  const id = startedTurnId(sent);
  const before = sent.length;
  session.close();
  session.handleInk({ type: 'turn.end', transcript: 'hi' });
  session.handleInterject(id, 'x');
  session.handleClient(audio(16000));
  session.handleTts(ttsChunk('c0', 4800));
  assert.equal(speaks.length, 0);
  assert.equal(pcm.length, 0);
  assert.equal(sent.length, before);
});

test('close stops the mock belief loop', async () => {
  const { session, sent, speaks } = setup({ mockBelief: true, mockSpeed: 5, useRealClock: true });
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.update', transcript: 'Draft a' });
  await waitFor(() => sent.some((e) => e.type === 'moss_hits'));
  session.close();
  const before = sent.length;
  await new Promise((r) => setTimeout(r, 900)); // mock reaches the interjection at ~500 ms at speed 5
  assert.equal(sent.length, before);
  assert.equal(speaks.length, 0);
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 5));
}

test('mock belief drives the interject path', async () => {
  const { session, sent, speaks } = setup({ mockBelief: true, mockSpeed: 50, useRealClock: true });
  session.handleInk({ type: 'turn.start' });
  session.handleInk({ type: 'turn.update', transcript: 'Draft a' });
  await waitFor(() => sent.some((e) => e.type === 'interject'));
  assert.ok(sent.some((e) => e.type === 'moss_hits'));
  assert.ok(sent.some((e) => e.type === 'belief_update'));
  const interjects = sent.filter((e) => e.type === 'interject');
  assert.equal(interjects.length, 1);
  assert.equal(interjects[0]?.type === 'interject' && interjects[0].text, DEMO_INTERJECTION);
  assert.ok(speaks.some((s) => s.opts.interrupt));
});

test('mock belief errors are reported, not thrown', async () => {
  const sent: ServerEvent[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const session = new VoiceSession({
    send: (e) => sent.push(e),
    ink: { sendPcm: () => {} },
    speaker: {
      speak: () => {
        throw new Error('boom');
      },
      cancelActive: () => null,
    },
    mockBelief: true,
    mockSpeed: 50,
  });
  const origError = console.error;
  console.error = () => {};
  try {
    session.handleInk({ type: 'turn.start' });
    session.handleInk({ type: 'turn.update', transcript: 'Draft a' });
    await waitFor(() => sent.some((e) => e.type === 'error'));
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    console.error = origError;
    process.off('unhandledRejection', onUnhandled);
  }
  const err = sent.find((e) => e.type === 'error');
  assert.equal(err?.type === 'error' && err.source, 'voice');
  assert.match(err?.type === 'error' ? err.message : '', /boom/);
  assert.equal(unhandled.length, 0);
});
