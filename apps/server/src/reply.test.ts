import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Belief, Claim } from '@ahead/contracts';
import {
  claimForInterject,
  correctBelief,
  correctionAck,
  mayBeConfirm,
  parseConfirm,
  stagedLine,
} from './reply.js';

function belief(intent: Belief['intent'], entities: Record<string, string>, claims: Claim[] = []): Belief {
  return { intent, entities, claims, confidence: 0.9, topHits: [], latencyMs: { moss: 1 } };
}

test('parseConfirm accepts yes and no phrases after normalization', () => {
  assert.equal(parseConfirm('Yes.'), true);
  assert.equal(parseConfirm('yeah'), true);
  assert.equal(parseConfirm('Go ahead!'), true);
  assert.equal(parseConfirm('No.'), false);
  assert.equal(parseConfirm('Never mind.'), false);
  assert.equal(parseConfirm("Don't."), false);
  assert.equal(parseConfirm('dont'), false);
});

test('parseConfirm returns null for anything else', () => {
  assert.equal(parseConfirm('Yes, and move it'), null);
  assert.equal(parseConfirm('move my meeting'), null);
  assert.equal(parseConfirm(''), null);
});

test('mayBeConfirm holds possible prefixes only', () => {
  for (const t of ['', 'Yes.', 'no', 'never', "don't", 'go']) assert.equal(mayBeConfirm(t), true, t);
  for (const t of ['Move my', 'Yes and']) assert.equal(mayBeConfirm(t), false, t);
});

test('stagedLine per action', () => {
  const resched = belief('reschedule_event', { person: 'Priya Shah', to_weekday: 'monday' });
  assert.equal(stagedLine(resched), 'I moved your meeting with Priya to Monday. Apply?');
  assert.equal(
    stagedLine(belief('reschedule_event', { person: 'Priya' })),
    'I moved your meeting with Priya. Apply?',
  );
  assert.equal(stagedLine(belief('draft_message', { person: 'Priya' })), 'I drafted a message to Priya. Apply?');
  assert.equal(stagedLine(belief('draft_message', {})), 'I drafted a message to them. Apply?');
  assert.equal(stagedLine(belief('add_note', {})), 'I added the note. Apply?');
  assert.equal(stagedLine(belief('find_file', {})), 'I found the file. Open it?');
  assert.equal(stagedLine(belief('lookup', {})), "It's ready. Apply?");
});

test('correctionAck capitalizes', () => {
  assert.equal(correctionAck('friday'), 'Okay, Friday.');
});

const claim: Claim = { field: 'day', said: 'Thursday', known: 'Friday', docId: 'cal-1' };

test('claimForInterject matches claim by said and known', () => {
  const b = belief('draft_message', { person: 'Priya', day: 'thursday' }, [claim]);
  assert.deepEqual(
    claimForInterject(b, "Heads up, Priya's meeting is Friday, not Thursday. Say Friday?"),
    claim,
  );
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
