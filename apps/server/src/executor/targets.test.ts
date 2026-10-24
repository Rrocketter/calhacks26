import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Belief } from '@ahead/contracts';
import { writeCalendarDir } from '../../../../scripts/calendar-layout.mjs';
import { contactTarget, eventTarget, targetsFor } from './targets.js';

const NOW = new Date(2026, 9, 24, 12); // Saturday
const SETI = (d: string) => ({ id: `g-evt-seti_${d}`, title: 'SETI Research Meeting', start: `${d}T13:00:00-07:00` });
const VQE = { id: 'g-evt-vqe_1', title: 'VQE Project Group Meeting', start: '2026-10-26T20:30:00-07:00' };

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahead-targets-'));
  writeCalendarDir([SETI('2026-10-13'), SETI('2026-10-27'), SETI('2026-11-03'), VQE], path.join(root, 'calendar'));
  fs.writeFileSync(
    path.join(root, 'contacts.json'),
    JSON.stringify({ contacts: [{ name: 'Esha Telang', notes: '12 events.' }, { name: 'Ayush Adi' }, { name: 'Ayush Kumar' }] }),
  );
  return root;
}

const belief = (intent: Belief['intent'], entities: Record<string, string>, hits: string[] = []): Belief => ({
  intent,
  entities,
  claims: [],
  confidence: 0.9,
  topHits: hits.map((docId) => ({ docId, score: 0.5, snippet: '' })),
  latencyMs: { moss: 1 },
});

test('eventTarget: the event slot names the event; the next occurrence on or after today wins', () => {
  const ws = workspace();
  const t = eventTarget(belief('reschedule_event', { event: 'SETI Research Meeting' }), ws, NOW);
  assert.deepEqual(t, { ...SETI('2026-10-27'), file: 'calendar/g-evt-seti_2026-10-27.json' });
});

test('eventTarget: without a slot, the first Moss hit that is a workspace event, even a past occurrence', () => {
  const ws = workspace();
  const t = eventTarget(belief('reschedule_event', {}, ['g-email-1', 'g-evt-seti_2026-10-13', 'g-evt-vqe_1']), ws, NOW);
  assert.equal(t?.id, 'g-evt-seti_2026-10-27');
});

test('eventTarget: null without an index or a match', () => {
  const ws = workspace();
  assert.equal(eventTarget(belief('reschedule_event', {}, ['g-email-1']), ws, NOW), null);
  assert.equal(eventTarget(belief('reschedule_event', { event: 'SETI Research Meeting' }), os.tmpdir(), NOW), null);
});

test('contactTarget: full name, else a unique first name', () => {
  const ws = workspace();
  assert.deepEqual(contactTarget(belief('draft_message', { person: 'Esha Telang' }), ws), { name: 'Esha Telang', notes: '12 events.' });
  assert.equal(contactTarget(belief('draft_message', { person: 'Esha' }), ws)?.name, 'Esha Telang');
  assert.equal(contactTarget(belief('draft_message', { person: 'Ayush' }), ws), null); // two Ayushes
  assert.equal(contactTarget(belief('draft_message', {}), ws), null);
});

test('targetsFor picks by intent', () => {
  const ws = workspace();
  assert.equal(targetsFor(belief('reschedule_event', { event: 'VQE Project Group Meeting' }), ws, NOW).event?.id, 'g-evt-vqe_1');
  assert.equal(targetsFor(belief('draft_message', { person: 'Esha' }), ws, NOW).contact?.name, 'Esha Telang');
  assert.deepEqual(targetsFor(belief('find_file', {}), ws, NOW), {});
});
