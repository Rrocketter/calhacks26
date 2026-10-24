import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Belief, Claim } from '@ahead/contracts';
import {
  claimForInterject,
  correctBelief,
  correctionAck,
  parseConfirm,
  stagedLine,
} from './reply.js';

function belief(intent: Belief['intent'], entities: Record<string, string>, claims: Claim[] = []): Belief {
  return { intent, entities, claims, confidence: 0.9, topHits: [], latencyMs: { moss: 1 } };
}

test('parseConfirm accepts the yes and no lexicon after normalization', () => {
  for (const t of ['Yes.', 'yeah', 'Yep', 'yup', 'Sure.', 'Okay.', 'ok', 'Apply.', 'Do it.', 'Go ahead!', 'Yes, please.', 'Yeah, do it.']) {
    assert.equal(parseConfirm(t), true, t);
  }
  for (const t of ['No.', 'Nope', "Don't.", 'dont', 'Cancel.', 'Discard', 'Drop it.', 'No, thanks.', 'Never mind.']) {
    assert.equal(parseConfirm(t), false, t);
  }
});

test('parseConfirm returns null for anything else', () => {
  for (const t of ['Yes, and move it', 'move my meeting', 'Okay so move my meeting', 'drop', '', 'yes no', 'please']) {
    assert.equal(parseConfirm(t), null, t);
  }
});

test('stagedLine is a short question', () => {
  assert.equal(stagedLine(belief('reschedule_event', { person: 'Priya Shah', to_weekday: 'monday' })), 'Apply?');
  assert.equal(stagedLine(belief('draft_message', { person: 'Priya' })), 'Apply?');
  assert.equal(stagedLine(belief('add_note', {})), 'Apply?');
  assert.equal(stagedLine(belief('find_file', {})), 'Open it?');
});

test('correctionAck capitalizes', () => {
  assert.equal(correctionAck('friday'), 'Friday.');
});

const claim: Claim = { field: 'day', said: 'Thursday', known: 'Friday', docId: 'cal-1' };

test('claimForInterject matches claim by its known value', () => {
  const b = belief('draft_message', { person: 'Priya', day: 'thursday' }, [claim]);
  assert.deepEqual(claimForInterject(b, 'Say Friday?'), claim);
  assert.equal(claimForInterject(b, 'Your lunch is at noon.'), undefined);
});

test('correctBelief fixes day and weekday without mutating input', () => {
  const b = belief('draft_message', { person: 'Priya', day: 'thursday', weekday: 'thursday' }, [claim]);
  const snapshot = structuredClone(b);
  const out = correctBelief(b, claim, new Date(2026, 9, 24));
  assert.equal(out.entities.day, 'friday');
  assert.equal(out.entities.weekday, 'friday');
  const iso = out.entities.date_iso!;
  assert.equal(new Date(`${iso}T12:00:00`).getDay(), 5);
  assert.deepEqual(b, snapshot);
});

test('correctBelief with unresolvable day keeps weekday', () => {
  const c: Claim = { ...claim, known: 'someday' };
  const b = belief('draft_message', { day: 'thursday', weekday: 'thursday' });
  const out = correctBelief(b, c, new Date(2026, 9, 24));
  assert.equal(out.entities.day, 'someday');
  assert.equal(out.entities.weekday, 'thursday');
});
