import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEntityExtractor, resolveDay } from './entities.js';

const extract = makeEntityExtractor([{ name: 'Priya Shah' }, { name: 'Marcus Lee' }]);

test('extractor builds up entities across partials', () => {
  assert.deepEqual(extract('draft a'), {});
  assert.deepEqual(extract('draft a message to priya'), { person: 'Priya Shah' });
  assert.deepEqual(extract('draft a message to priya saying i will see her thursday'), {
    person: 'Priya Shah',
    day: 'thursday',
  });
  assert.deepEqual(extract('draft a message to priya saying i will see her thursday at 2'), {
    person: 'Priya Shah',
    day: 'thursday',
    time: '2',
  });
  assert.deepEqual(
    extract('draft a message to priya saying i will see her thursday at 2 for the q3 deck'),
    { person: 'Priya Shah', day: 'thursday', time: '2', file: 'q3 deck' },
  );
});

test('extractor matches whole words only', () => {
  assert.equal(extract('priyanka').person, undefined);
});

test('extractor matches full name, am/pm times, today and tomorrow', () => {
  assert.equal(extract('email marcus lee').person, 'Marcus Lee');
  assert.equal(extract('see you tomorrow at 3 pm').time, '3 pm');
  assert.equal(extract('see you tomorrow at 3 pm').day, 'tomorrow');
  assert.equal(extract('lunch 12 am today').time, '12 am');
  assert.equal(extract('lunch 12 am today').day, 'today');
  assert.equal(extract('open the budget').file, 'budget');
});

test('extractor reads morning, noon, afternoon and evening as a time', () => {
  const resched = extract('move my friday meeting with priya to monday morning');
  assert.deepEqual(resched, { person: 'Priya Shah', day: 'friday', time: '09:00' });
  assert.equal(extract('lunch at noon tomorrow').time, '12:00');
  assert.equal(extract('call marcus this afternoon').time, '14:00');
  assert.equal(extract('dinner on friday evening').time, '18:00');
  assert.equal(extract('see her monday morning at 10').time, '10', 'a clock time wins');
  assert.equal(extract('mornings are busy').time, undefined, 'whole words only');
});

test('resolveDay uses local dates', () => {
  const today = new Date(2026, 9, 24); // Saturday
  assert.deepEqual(resolveDay('thursday', today), { weekday: 'thursday', date_iso: '2026-10-29' });
  assert.deepEqual(resolveDay('friday', today), { weekday: 'friday', date_iso: '2026-10-30' });
  assert.deepEqual(resolveDay('saturday', today), { weekday: 'saturday', date_iso: '2026-10-24' });
  assert.deepEqual(resolveDay('tomorrow', today), { weekday: 'sunday', date_iso: '2026-10-25' });
  assert.deepEqual(resolveDay('today', today), { weekday: 'saturday', date_iso: '2026-10-24' });
  assert.deepEqual(resolveDay('monday', today), { weekday: 'monday', date_iso: '2026-10-26' });
});

test('resolveDay crosses month and year boundaries', () => {
  assert.deepEqual(resolveDay('tomorrow', new Date(2026, 11, 31)), {
    weekday: 'friday',
    date_iso: '2027-01-01',
  });
});
