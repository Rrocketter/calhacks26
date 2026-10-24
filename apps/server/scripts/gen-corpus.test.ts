import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/env.js';
import { generateCorpus } from './gen-corpus.js';

const seed = (p: string): string => path.join(REPO_ROOT, 'workspace-seed', p);
const byId = (id: string) => {
  const d = generateCorpus(1).find((x) => x.id === id);
  assert.ok(d, `missing ${id}`);
  return d;
};

test('corpus size is 300..500 and ids are unique', () => {
  const c = generateCorpus(1);
  assert.ok(c.length >= 300 && c.length <= 500, `size ${c.length}`);
  assert.equal(new Set(c.map((d) => d.id)).size, c.length);
});

test('all metadata values are strings', () => {
  for (const d of generateCorpus(1)) {
    for (const [k, v] of Object.entries(d.metadata)) {
      assert.equal(typeof v, 'string', `${d.id}.${k}`);
    }
  }
});

test('demo facts present verbatim', () => {
  const e = byId('evt-priya-q3');
  for (const s of ['Q3 deck review with Priya Shah', 'Friday', '2 PM', 'Conference Room B']) {
    assert.ok(e.text.includes(s), s);
  }
  assert.equal(e.metadata.day, 'friday');
  assert.equal(e.metadata.time, '2 pm');
  assert.ok(e.metadata.people.includes('Priya Shah'));
  const c = byId('contact-priya');
  assert.ok(c.text.includes('Priya Shah') && c.text.includes('priya.shah@example.com'));
  assert.ok(byId('file-q3-deck').text.includes('files/q3-deck.pdf'));
});

test('every workspace-seed record has a doc', () => {
  const ids = new Set(generateCorpus(1).map((d) => d.id));
  const cal = JSON.parse(fs.readFileSync(seed('calendar.json'), 'utf8')) as { events: { id: string }[] };
  const con = JSON.parse(fs.readFileSync(seed('contacts.json'), 'utf8')) as { contacts: { id: string }[] };
  for (const r of [...cal.events, ...con.contacts]) assert.ok(ids.has(r.id), r.id);
  for (const f of fs.readdirSync(seed('notes'))) {
    assert.ok(ids.has(`note-${f.replace(/\.md$/, '')}`), f);
  }
  assert.ok(ids.has('file-q3-deck'));
  assert.ok(ids.has('file-budget-2026'));
});

test('deterministic', () => {
  assert.deepEqual(generateCorpus(1), generateCorpus(1));
});

test('only one Priya, and no Thursday Priya event', () => {
  const c = generateCorpus(1);
  const seeded = new Set(['contact-priya', 'evt-priya-q3', 'note-2026-10-20-q3-planning', 'file-q3-deck']);
  for (const d of c) {
    if (!seeded.has(d.id)) assert.ok(!/priya/i.test(d.text + d.metadata.people), d.id);
    for (const p of d.metadata.people.split(', ')) {
      if (/^priya/i.test(p)) assert.equal(p, 'Priya Shah');
    }
  }
  const bad = c.filter(
    (d) => d.metadata.type === 'calendar' && d.metadata.day === 'thursday' && /priya/i.test(d.metadata.people + d.text),
  );
  assert.equal(bad.length, 0);
});
