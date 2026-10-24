import { describe, expect, it } from 'vitest';
import type { Belief } from '@ahead/contracts';
import { buildCard, highlightSegments, intentLabel, newFileText, productChips, wallTime, type CardInput } from './cards';

const belief = (intent: Belief['intent'], entities: Record<string, string> = {}, claims: Belief['claims'] = []): Belief => ({
  intent,
  entities,
  claims,
  confidence: 0.9,
  topHits: [],
  latencyMs: { moss: 1 },
});

const input = (over: Partial<CardInput> = {}): CardInput => ({
  turnId: 't1',
  belief: null,
  diffs: [],
  result: null,
  tools: [],
  finals: [],
  replies: [],
  ...over,
});

// New file, as `git diff main..spec/<turnId>` prints it.
const OUTBOX = `diff --git a/messages/outbox/esha.md b/messages/outbox/esha.md
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/messages/outbox/esha.md
@@ -0,0 +1,3 @@
+To: Esha Telang
+
+I'll present the VQE results at Monday's group meeting.
`;

const CALENDAR = `diff --git a/calendar/g-evt-seti_20261027T200000Z.json b/calendar/g-evt-seti_20261027T200000Z.json
index 8205574..e4ab07e 100644
--- a/calendar/g-evt-seti_20261027T200000Z.json
+++ b/calendar/g-evt-seti_20261027T200000Z.json
@@ -1,8 +1,8 @@
 {
   "id": "g-evt-seti_20261027T200000Z",
   "title": "SETI Research Meeting",
-  "start": "2026-10-27T13:00:00-07:00",
-  "end": "2026-10-27T14:00:00-07:00",
+  "start": "2026-10-28T14:00:00-07:00",
+  "end": "2026-10-28T15:00:00-07:00",
   "attendees": [],
   "location": "Campbell Hall"
 }
`;

const NOTE = `diff --git a/notes/2026-10-24-vqe-ideas.md b/notes/2026-10-24-vqe-ideas.md
new file mode 100644
--- /dev/null
+++ b/notes/2026-10-24-vqe-ideas.md
@@ -0,0 +1,4 @@
+# VQE ideas
+
+- try a smaller ansatz
+- rerun on the noisy simulator
`;

describe('newFileText', () => {
  it('rebuilds the post-image of a new file', () => {
    expect(newFileText(OUTBOX)).toBe("To: Esha Telang\n\nI'll present the VQE results at Monday's group meeting.");
  });
  it('keeps context lines and drops deleted ones', () => {
    expect(newFileText(CALENDAR)).toContain('"start": "2026-10-28T14:00:00-07:00"');
    expect(newFileText(CALENDAR)).not.toContain('2026-10-27T13:00');
    expect(newFileText(CALENDAR)).toContain('"title": "SETI Research Meeting"');
  });
  it('is empty for an empty or header-only diff', () => {
    expect(newFileText('')).toBe('');
    expect(newFileText('diff --git a/x b/x\n')).toBe('');
  });
});

describe('wallTime', () => {
  it('reads the wall clock from the ISO string, not the browser zone', () => {
    expect(wallTime('2026-10-27T13:00:00-07:00')).toEqual({ day: 'Tue, Oct 27', time: '1:00 PM' });
    expect(wallTime('2026-11-02T09:30:00-08:00')).toEqual({ day: 'Mon, Nov 2', time: '9:30 AM' });
    expect(wallTime('2026-10-26T00:00:00-07:00')).toEqual({ day: 'Mon, Oct 26', time: '12:00 AM' });
  });
  it('is null for anything else', () => {
    expect(wallTime('tomorrow')).toBeNull();
  });
});

describe('intentLabel', () => {
  it('says what the agent is doing in plain words', () => {
    expect(intentLabel(belief('draft_message', { person: 'Esha Telang' }))).toBe('Drafting a message to Esha Telang');
    expect(intentLabel(belief('reschedule_event', { event: 'SETI Research Meeting', topic: 'SETI' }))).toBe('Moving: SETI Research Meeting');
    expect(intentLabel(belief('reschedule_event', { topic: 'SETI' }))).toBe('Moving: SETI');
    expect(intentLabel(belief('find_file', { file: 'SETI slides' }))).toBe('Finding: SETI slides');
    expect(intentLabel(belief('add_note', { topic: 'VQE ideas' }))).toBe('Writing a note: VQE ideas');
    expect(intentLabel(belief('lookup', { topic: 'Math 52 homework' }))).toBe('Looking up: Math 52 homework');
  });
  it('falls back without entities', () => {
    expect(intentLabel(belief('draft_message'))).toBe('Drafting a message');
    expect(intentLabel(belief('lookup'))).toBe('Answering a question');
    expect(intentLabel(belief('unknown'))).toBe('Listening');
    expect(intentLabel(null)).toBe('Listening');
  });
});

describe('productChips', () => {
  it('drops derived and internal entities, names keys plainly, and shows what a correction replaced', () => {
    const chips = productChips({
      person: 'Esha Telang',
      day: 'monday',
      superseded_day: 'tuesday',
      weekday: 'monday',
      date_iso: '2026-10-26',
      message: "I'll present the VQE results",
      to_date_iso: '2026-10-28',
      to_weekday: 'wednesday',
    });
    expect(chips).toEqual([
      { key: 'person', label: 'Who', value: 'Esha Telang' },
      { key: 'day', label: 'Day', value: 'Monday', was: 'Tuesday' },
      { key: 'to_weekday', label: 'New day', value: 'Wednesday' },
    ]);
  });
  it('keeps weekday when no day was said', () => {
    expect(productChips({ weekday: 'friday' })).toEqual([{ key: 'weekday', label: 'Day', value: 'Friday' }]);
  });
});

describe('highlightSegments', () => {
  it('marks whole-word, case-insensitive matches', () => {
    expect(highlightSegments("at Monday's meeting, monday", ['Monday'])).toEqual([
      { text: 'at ', mark: false },
      { text: 'Monday', mark: true },
      { text: "'s meeting, ", mark: false },
      { text: 'monday', mark: true },
    ]);
  });
  it('does not mark inside other words, and passes text through with nothing to mark', () => {
    expect(highlightSegments('Mondays', ['Monday'])).toEqual([{ text: 'Mondays', mark: false }]);
    expect(highlightSegments('hi', [])).toEqual([{ text: 'hi', mark: false }]);
  });
});

describe('buildCard', () => {
  it('turns an outbox diff into a mail draft with the corrected word highlighted', () => {
    const b = belief('draft_message', { person: 'Esha Telang', day: 'monday', superseded_day: 'tuesday' }, [
      { field: 'day', said: 'Tuesday', known: 'Monday', docId: 'cal' },
    ]);
    expect(buildCard(input({ belief: b, diffs: [{ file: 'messages/outbox/esha.md', diff: OUTBOX }] }))).toEqual({
      kind: 'message',
      file: 'messages/outbox/esha.md',
      to: 'Esha Telang',
      subject: null,
      body: "I'll present the VQE results at Monday's group meeting.",
      highlight: ['Monday'],
    });
  });

  it('reads a Subject line and falls back to the belief for To', () => {
    const diff = OUTBOX.replace('+To: Esha Telang\n', '+Subject: VQE results\n');
    const card = buildCard(input({ belief: belief('draft_message', { person: 'Esha Telang' }), diffs: [{ file: 'messages/outbox/esha.md', diff }] }));
    expect(card).toMatchObject({ kind: 'message', to: 'Esha Telang', subject: 'VQE results' });
  });

  it('turns a calendar diff into a before / after event tile', () => {
    const card = buildCard(input({ belief: belief('reschedule_event', { topic: 'SETI' }), diffs: [{ file: 'calendar/g-evt-seti_20261027T200000Z.json', diff: CALENDAR }] }));
    expect(card).toEqual({
      kind: 'event',
      file: 'calendar/g-evt-seti_20261027T200000Z.json',
      title: 'SETI Research Meeting',
      location: 'Campbell Hall',
      before: { day: 'Tue, Oct 27', time: '1:00 PM', end: '2:00 PM' },
      after: { day: 'Wed, Oct 28', time: '2:00 PM', end: '3:00 PM' },
    });
  });

  it('reads the old single calendar.json shape too, title from the belief when the diff has none', () => {
    const diff = `--- a/calendar.json
+++ b/calendar.json
@@ -29,2 +29,2 @@
-      "start": "2026-10-30T14:00:00-07:00",
+      "start": "2026-11-02T09:00:00-08:00",
`;
    const card = buildCard(input({ belief: belief('reschedule_event', { event: 'Q3 deck review' }), diffs: [{ file: 'calendar.json', diff }] }));
    expect(card).toMatchObject({
      kind: 'event',
      title: 'Q3 deck review',
      before: { day: 'Fri, Oct 30', time: '2:00 PM', end: null },
      after: { day: 'Mon, Nov 2', time: '9:00 AM', end: null },
    });
  });

  it('turns a notes diff into a note card', () => {
    expect(buildCard(input({ belief: belief('add_note'), diffs: [{ file: 'notes/2026-10-24-vqe-ideas.md', diff: NOTE }] }))).toEqual({
      kind: 'note',
      file: 'notes/2026-10-24-vqe-ideas.md',
      title: 'VQE ideas',
      lines: ['try a smaller ansatz', 'rerun on the noisy simulator'],
    });
  });

  it('finds the file path in the result summary, else the last Read, else the belief', () => {
    const b = belief('find_file', { file: 'SETI slides' });
    expect(buildCard(input({ belief: b, result: { ok: true, failed: false, summary: 'files/seti-slides.pdf. It is the only SETI deck.' } }))).toEqual({
      kind: 'file',
      path: 'files/seti-slides.pdf',
      name: 'seti-slides.pdf',
      type: 'PDF',
      why: 'It is the only SETI deck.',
    });
    expect(buildCard(input({ belief: b, tools: [{ tool: 'Read', path: 'files/budget-2026.xlsx.txt', denied: false }] }))).toMatchObject({
      kind: 'file',
      name: 'budget-2026.xlsx.txt',
      type: 'XLSX',
      why: null,
    });
    expect(buildCard(input({ belief: b }))).toMatchObject({ kind: 'file', path: null, name: 'SETI slides', type: null });
  });

  it('ignores denied reads for the file card', () => {
    const b = belief('find_file');
    expect(buildCard(input({ belief: b, tools: [{ tool: 'Read', path: '../../.env', denied: true }] }))).toBeNull();
  });

  it('turns a lookup into a question and the spoken answer', () => {
    const card = buildCard(
      input({
        belief: belief('lookup'),
        finals: [{ turnId: 't1', text: 'When is my Math 52 homework due?', highlight: null }],
        replies: [
          { seq: 1, turnId: 't0', text: 'Done.', kind: 'ack' },
          { seq: 2, turnId: 't1', text: 'Monday, October 26 at 11:59 PM.', kind: 'answer' },
        ],
      }),
    );
    expect(card).toEqual({ kind: 'answer', question: 'When is my Math 52 homework due?', answer: 'Monday, October 26 at 11:59 PM.' });
  });

  it('shows the lookup question before the answer lands', () => {
    const card = buildCard(input({ belief: belief('lookup'), finals: [{ turnId: 't1', text: 'What did I tell Esha?', highlight: null }] }));
    expect(card).toEqual({ kind: 'answer', question: 'What did I tell Esha?', answer: null });
  });

  it('a lookup belief left from the last turn does not hide this turn\'s staged draft', () => {
    const card = buildCard(input({ turnId: 't2', belief: belief('lookup'), diffs: [{ file: 'messages/outbox/esha.md', diff: OUTBOX }] }));
    expect(card).toMatchObject({ kind: 'message', to: 'Esha Telang' });
  });

  it('is null with nothing to show', () => {
    expect(buildCard(input())).toBeNull();
    expect(buildCard(input({ belief: belief('reschedule_event'), diffs: [{ file: 'calendar/x.json', diff: '' }] }))).toBeNull();
  });
});
