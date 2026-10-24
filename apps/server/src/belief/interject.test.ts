import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventPhrase, spokenTime, topicWords } from './interject.js';
import { normalize } from './normalize.js';

const said = (s: string) => normalize(s);

test('topicWords: title words the user said, minus generic words and attendee names', () => {
  const t = said("Draft a message to Esha saying I'll present the VQE results at Tuesday's group meeting");
  assert.deepEqual(topicWords('VQE Project Group Meeting', t, 'Esha Telang'), ['VQE']);
  assert.deepEqual(topicWords('Meeting with Esha', t, 'Esha Telang'), []);
  assert.deepEqual(topicWords(undefined, t), []);
});

test('eventPhrase: topic plus kind, else the title', () => {
  assert.equal(eventPhrase('VQE Project Group Meeting', said('present the VQE results at the group meeting')), 'the VQE meeting');
  assert.equal(eventPhrase('SETI Research Meeting', said('move my SETI research meeting')), 'the SETI research meeting');
  assert.equal(eventPhrase('Q3 deck review with Priya', said('see her thursday'), 'Priya Shah'), 'the Q3 deck review with Priya');
  assert.equal(eventPhrase('Sync', said('see her thursday')), 'the sync');
  assert.equal(eventPhrase(undefined, ''), 'that event');
});

test('spokenTime drops am / pm', () => {
  assert.equal(spokenTime('8:30 pm'), '8:30');
  assert.equal(spokenTime('2 PM'), '2');
  assert.equal(spokenTime('11 a.m.'), '11');
  assert.equal(spokenTime(undefined), '');
});
