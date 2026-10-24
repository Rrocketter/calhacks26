import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Belief } from '@ahead/contracts';
import { normalize } from '../src/belief/normalize.js';
import { printVerdict, ReplayTap } from './replay.js';

const DEMO_TEXT = 'Say Friday?';

function belief(intent: Belief['intent'], person?: string): Belief {
  return {
    intent,
    entities: person ? { person } : {},
    claims: [],
    confidence: 0.94,
    topHits: [],
    latencyMs: { moss: 3 },
  };
}

/** Partials 0..3 at 0/250/500/750 ms; "Thursday" is #2. */
function goodTap(): ReplayTap {
  const tap = new ReplayTap();
  const texts = ['Draft', 'Draft a message to Priya', 'Draft a message to Priya Thursday', 'Draft a message to Priya Thursday at 2'];
  tap.partials = texts.map((text, i) => ({ text, norm: normalize(text), atMs: i * 250 }));
  tap.lock = { atMs: 400, idx: 1, belief: belief('draft_message', 'Priya Shah') };
  tap.interject = { atMs: 520, idx: 2, text: DEMO_TEXT };
  return tap;
}

function verdict(tap: ReplayTap): { pass: boolean; out: string } {
  const lines: string[] = [];
  const pass = printVerdict(tap, 'Thursday', (l) => lines.push(l));
  return { pass, out: lines.join('\n') };
}

test('good timeline passes and prints what was locked and said', () => {
  const { pass, out } = verdict(goodTap());
  assert.equal(pass, true, out);
  assert.match(out, /draft_message/);
  assert.match(out, /Priya Shah/);
  assert.ok(out.includes(DEMO_TEXT), out);
  assert.match(out, /PASS$/);
});

test('lock attributed before the said partial but landing after it fails', () => {
  const tap = goodTap();
  tap.lock = { ...tap.lock!, atMs: 510 }; // said partial arrived at 500
  assert.equal(verdict(tap).pass, false);
});

test('interject landing after the next partial arrived fails', () => {
  const tap = goodTap();
  tap.interject = { ...tap.interject!, atMs: 760 }; // next partial at 750
  assert.equal(verdict(tap).pass, false);
});

test('interject on the last partial has no upper bound', () => {
  const tap = goodTap();
  tap.partials = tap.partials.slice(0, 3);
  tap.interject = { ...tap.interject!, atMs: 5000 };
  assert.equal(verdict(tap).pass, true);
});

test('wrong locked intent fails', () => {
  const tap = goodTap();
  tap.lock = { ...tap.lock!, belief: belief('find_file', 'Priya Shah') };
  assert.equal(verdict(tap).pass, false);
});

test('wrong locked person fails', () => {
  const tap = goodTap();
  tap.lock = { ...tap.lock!, belief: belief('draft_message', 'Marcus Lee') };
  assert.equal(verdict(tap).pass, false);
});

test('wrong interject text fails', () => {
  const tap = goodTap();
  tap.interject = { ...tap.interject!, text: 'Say Thursday?' };
  assert.equal(verdict(tap).pass, false);
});

test('error events without a turnId are printed', () => {
  const lines: string[] = [];
  const tap = new ReplayTap();
  tap.print = (l) => lines.push(l);
  tap.turnId = 't1';
  tap.emit({ type: 'error', source: 'llm', message: 'overloaded' });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /ERROR llm overloaded/);
});
