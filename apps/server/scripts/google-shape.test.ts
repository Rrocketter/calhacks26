import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  calendarLabel,
  deriveContacts,
  namesFromTitle,
  parseExclude,
  redactEmails,
  selectCalendars,
  shapeEvents,
  shapeThreads,
  toCorpus,
  type GCalendar,
  type GEvent,
  type GThread,
} from './google-shape.js';

const fx = (f: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'google', f), 'utf8'));
const events = fx('events.json') as GEvent[];
const threads = fx('threads.json') as GThread[];
const TZ = 'America/Los_Angeles';
const SELF = 'me@example.com';
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const shaped = () => {
  const evs = shapeEvents(events, TZ);
  const { kept, skipped } = shapeThreads(threads, SELF, TZ);
  const contacts = deriveContacts(evs, kept, SELF);
  return { evs, kept, skipped, contacts, corpus: toCorpus(evs, contacts, kept) };
};

test('calendars: owner/writer kept, read-only skipped, address names labeled by domain, exclude', () => {
  const list = fx('calendars.json') as GCalendar[];
  assert.deepEqual(selectCalendars(list, []), {
    kept: [
      { id: 'me@example.com', label: 'primary' },
      { id: 'me@school.example.edu', label: 'school.example.edu' },
      { id: 'r1@group.calendar.google.com', label: 'Research' },
      { id: 'r2@group.calendar.google.com', label: 'Recruiting' },
    ],
    readOnly: 2,
    excluded: [],
  });
  const ex = selectCalendars(list, parseExclude(' recruiting, School.Example.edu ,'));
  assert.deepEqual(ex.kept.map((c) => c.label), ['primary', 'Research']);
  assert.deepEqual(ex.excluded, ['school.example.edu', 'Recruiting']);
  assert.equal(calendarLabel({ summary: 'Old', summaryOverride: 'Astro Club' }), 'Astro Club');
  assert.deepEqual(parseExclude(undefined), []);
});

test('namesFromTitle: people after "with", separators, stop words', () => {
  assert.deepEqual(namesFromTitle('Pulsar Project with Hayk & Luka'), ['Hayk', 'Luka']);
  assert.deepEqual(namesFromTitle('Coffee w/ Esha Telang, Sam and Jo (tentative)'), ['Esha Telang', 'Sam', 'Jo']);
  assert.deepEqual(namesFromTitle('Sync with the team (weekly)'), []);
  assert.deepEqual(namesFromTitle('Meet with Team'), []);
  assert.deepEqual(namesFromTitle('1:1 with Ana - prep'), ['Ana']);
  assert.deepEqual(namesFromTitle('Weekly NICER CfA Meeting'), []);
});

test('events: seed shape plus calendar, cancelled and cross-calendar duplicates dropped, self and resource attendees dropped', () => {
  const evs = shapeEvents(events, TZ);
  assert.deepEqual(
    evs.map((e) => e.id),
    ['g-evt-abc123', 'g-evt-allday_1', 'g-evt-nameless_1', 'g-evt-pulsar_1', 'g-evt-lunch_1', 'g-evt-team_1'],
  );
  const [review, allday, nameless, pulsar, lunch, team] = evs;
  assert.deepEqual(review, {
    id: 'g-evt-abc123',
    title: 'Design review with Lena',
    start: '2026-10-30T14:00:00-07:00',
    end: '2026-10-30T15:00:00-07:00',
    attendees: ['Lena Okafor'],
    location: 'Conference Room B',
    calendar: 'primary',
  });
  assert.equal(allday!.calendar, 'Research');
  assert.deepEqual(pulsar!.attendees, ['Hayk', 'Luka']);
  assert.deepEqual(lunch!.attendees, ['Lena Okafor']);
  assert.deepEqual(team!.attendees, []);
  assert.equal(allday!.start, '2026-11-12T00:00:00-08:00');
  assert.equal(allday!.end, '2026-11-13T00:00:00-08:00');
  assert.deepEqual(allday!.attendees, []);
  assert.equal(allday!.location, '');
  assert.equal(nameless!.title, '(no title)');
  assert.deepEqual(nameless!.attendees, ['Hugo Haas']);
});

test('threads: blocklisted subjects skipped, counts only', () => {
  const { kept, skipped } = shapeThreads(threads, SELF, TZ);
  assert.deepEqual(kept.map((t) => t.id), ['t1', 't6', 't7']);
  assert.equal(skipped, 4);
});

test('threads: first message, plain body preferred, html stripped, snippet fallback, 500 cap', () => {
  const { kept } = shapeThreads(threads, SELF, TZ);
  const [agenda, news, lunch] = kept;
  assert.equal(agenda!.subject, 'Agenda for Thursday');
  assert.deepEqual(agenda!.from, { name: 'Lena Okafor', email: 'lena.okafor@example.com' });
  assert.equal(agenda!.date, '2026-10-22');
  assert.equal(agenda!.day, 'thursday');
  assert.ok(agenda!.body.startsWith('Hi! Here is the agenda for Thursday.'));
  assert.ok(!agenda!.body.includes('ignored'));
  assert.ok(agenda!.body.length <= 500, `len ${agenda!.body.length}`);
  assert.equal(news!.body, 'Hello reader & friends');
  assert.equal(lunch!.body, 'See you there');
  assert.equal(lunch!.fromSelf, true);
  assert.deepEqual(lunch!.to, [{ name: 'Hugo Haas', email: 'hugo_haas2@example.com' }]);
});

test('redactEmails: known address to name, unknown to [email], links collapsed', () => {
  const known = new Map([['hugo_haas2@example.com', 'Hugo Haas']]);
  assert.equal(
    redactEmails('ask Hugo <hugo_haas2@example.com> or x.y@z.org via https://a.b/c?t=1', known),
    'ask Hugo or [email] via [link]',
  );
  assert.equal(redactEmails('ping hugo_haas2@example.com', known), 'ping Hugo Haas');
  assert.equal(redactEmails('"Hugo H" <hugo_haas2@example.com> wrote', known), 'Hugo H wrote');
});

test('contacts: attendees, title names, and senders; name only, sources, no self, no noreply', () => {
  const { contacts } = shaped();
  assert.deepEqual(contacts, [
    { id: 'g-contact-lena-okafor', name: 'Lena Okafor', notes: '2 events, 1 email thread.', sources: ['primary', 'gmail'] },
    { id: 'g-contact-hugo-haas', name: 'Hugo Haas', notes: '1 event.', sources: ['school.example.edu'] },
    { id: 'g-contact-hayk', name: 'Hayk', notes: '1 event.', sources: ['Research'] },
    { id: 'g-contact-luka', name: 'Luka', notes: '1 event.', sources: ['Research'] },
  ]);
  assert.ok(!EMAIL_RE.test(JSON.stringify(contacts)), 'contacts.json must hold no addresses');
});

test('corpus: unique ids, string metadata, no email addresses anywhere', () => {
  const { corpus } = shaped();
  assert.equal(new Set(corpus.map((d) => d.id)).size, corpus.length);
  for (const d of corpus) {
    assert.ok(!EMAIL_RE.test(d.text), `${d.id} text has an address`);
    for (const [k, v] of Object.entries(d.metadata)) {
      assert.equal(typeof v, 'string', `${d.id}.${k}`);
      assert.ok(!EMAIL_RE.test(v as string), `${d.id}.${k} has an address`);
    }
  }
});

test('corpus: doc shapes match gen-corpus', () => {
  const { corpus } = shaped();
  const byId = (id: string) => corpus.find((d) => d.id === id)!;
  const evt = byId('g-evt-abc123');
  assert.equal(evt.text, 'Design review with Lena Okafor. Friday, October 30 at 2 PM in Conference Room B. With Lena Okafor.');
  assert.deepEqual(evt.metadata, {
    type: 'calendar', date: '2026-10-30', people: 'Lena Okafor', day: 'friday', time: '2 pm', title: 'Design review with Lena Okafor',
    calendar: 'primary',
  });
  assert.equal(byId('g-evt-pulsar_1').text, 'Pulsar Project with Hayk & Luka. Friday, October 30 at 5:30 PM. With Hayk, Luka.');
  assert.ok(byId('g-evt-nameless_1').text.includes('in [link] call me at [email].'));
  const con = byId('g-contact-lena-okafor');
  assert.equal(con.text, 'Lena Okafor. 2 events, 1 email thread.');
  assert.deepEqual(con.metadata, { type: 'contact', date: '2026-11-02', people: 'Lena Okafor', title: 'Lena Okafor' });
  const mail = byId('g-email-t1');
  assert.ok(mail.text.startsWith('Email from Lena Okafor. Subject: Agenda for Thursday. Sent thursday. Hi! Here is'));
  assert.ok(mail.text.includes('Loop in Hugo and [email], doc at [link] thanks.'));
  assert.deepEqual(mail.metadata, { type: 'email', date: '2026-10-22', people: 'Lena Okafor', title: 'Agenda for Thursday' });
  const sent = byId('g-email-t7');
  assert.ok(sent.text.startsWith('Email from me to Hugo Haas. Subject: Lunch?.'));
  assert.equal(sent.metadata.people, 'Hugo Haas');
});

test('corpus: all-day event with no location reads cleanly', () => {
  const d = shaped().corpus.find((x) => x.id === 'g-evt-allday_1')!;
  assert.equal(d.text, 'Offsite. Thursday, November 12 at 12 AM.');
});

test('threads: format=metadata (headers + snippet, no body) uses the snippet', () => {
  const meta: GThread = {
    id: 'tm',
    messages: [{
      id: 'mm',
      internalDate: String(Date.parse('2026-10-23T18:00:00Z')),
      snippet: 'Let&#39;s meet at 3 &amp; bring the deck',
      payload: { mimeType: 'multipart/alternative', headers: [
        { name: 'Subject', value: 'Friday' },
        { name: 'From', value: 'Lena Okafor <lena.okafor@example.com>' },
      ] },
    }],
  };
  const [m] = shapeThreads([meta], SELF, TZ).kept;
  assert.equal(m!.body, "Let's meet at 3 & bring the deck");
  assert.equal(m!.date, '2026-10-23');
});

test('review fixes: own address on other calendars, empty and address-like names, redacted calendar.json fields, label with address', () => {
  const evs = shapeEvents(
    [
      {
        id: 'x1',
        calendar: 'Research',
        summary: 'Sync re me@example.com notes',
        location: 'https://zoom.us/j/1 or desk',
        start: { dateTime: '2026-10-30T09:00:00-07:00' },
        attendees: [
          { email: 'ME@example.com', displayName: 'Me Myself' },
          { email: '12345@example.com' },
          { email: 'john@corp.com', displayName: 'John (john at corp.com)' },
        ],
      },
    ],
    TZ,
    SELF,
  );
  assert.deepEqual(evs[0]!.attendees, ['John']);
  assert.equal(evs[0]!.title, 'Sync re [email] notes');
  assert.equal(evs[0]!.location, '[link] or desk');
  assert.equal(calendarLabel({ summary: "a@b.com's cal" }), "[email]'s cal");
  const noDate: GThread = { id: 'nd', messages: [{ id: 'm', payload: { headers: [{ name: 'Subject', value: 'x' }] } }] };
  assert.equal(shapeThreads([noDate], SELF, TZ).kept.length, 0);
});
