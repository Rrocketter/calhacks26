import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/env.js';
import type { CorpusDoc } from '../src/belief/types.js';

export type SeedEvent = { id: string; title: string; start: string; end: string; attendees: string[]; location: string };
export type SeedContact = { id: string; name: string; email: string; phone: string; notes: string };

const SEED = path.join(REPO_ROOT, 'workspace-seed');
const OUT = path.join(REPO_ROOT, 'data', 'corpus', 'corpus.json');

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Seeded PRNG so the corpus is reproducible.
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Parse the local wall-clock of an ISO string; ignores the offset and the machine timezone.
function wall(iso: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) throw new Error(`bad ISO time: ${iso}`);
  return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]! };
}

function weekday(y: number, mo: number, d: number): string {
  return DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]!;
}

function clock(h: number, mi: number, upper: boolean): string {
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const s = `${h12}${mi ? `:${String(mi).padStart(2, '0')}` : ''} ${suffix}`;
  return upper ? s.toUpperCase() : s;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fullNames(title: string, attendees: string[]): string {
  let out = title;
  for (const full of attendees) {
    const first = full.split(' ')[0]!;
    out = out.replace(new RegExp(`\\b${first}\\b(?! ${full.split(' ')[1] ?? ''})`), full);
  }
  return out;
}

export function calendarDoc(e: SeedEvent): CorpusDoc {
  const s = wall(e.start);
  const day = weekday(s.y, s.mo, s.d);
  const title = fullNames(e.title, e.attendees);
  const who = e.attendees.length ? ` With ${e.attendees.join(', ')}.` : '';
  return {
    id: e.id,
    text: `${title}. ${cap(day)}, ${MONTHS[s.mo - 1]} ${s.d} at ${clock(s.h, s.mi, true)}${e.location ? ` in ${e.location}` : ''}.${who}`,
    metadata: {
      type: 'calendar',
      date: e.start.slice(0, 10),
      people: e.attendees.join(', '),
      day,
      time: clock(s.h, s.mi, false),
      title,
    },
  };
}

const FIRST = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Rowan',
  'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Nora', 'Owen', 'Lena', 'Hugo', 'Ines',
  'Kenji', 'Amara', 'Tomas', 'Elif', 'Mateo', 'Sofia', 'Omar', 'Hana', 'Felix', 'Wen',
  'Ravi', 'Greta', 'Diego', 'Leila', 'Nico', 'Sana', 'Theo', 'Yuki', 'Beck', 'Cleo',
];
const LAST = [
  'Nguyen', 'Patel', 'Kim', 'Garcia', 'Okafor', 'Novak', 'Haas', 'Moreau', 'Silva', 'Chen',
  'Larsen', 'Ito', 'Brooks', 'Reyes', 'Walsh', 'Duarte', 'Kaplan', 'Osei', 'Bianchi', 'Fox',
];
const ROLES = [
  'Designer on the growth team.', 'Recruiter, mostly early-career hires.', 'Sales lead for the west region.',
  'Backend engineer, owns the billing service.', 'Legal counsel, reviews vendor contracts.',
  'Customer success manager.', 'Data analyst, builds the weekly metrics.', 'Founder of a partner startup.',
  'Landlord contact for the office.', 'Freelance copywriter.', 'Security engineer.', 'Investor relations contact.',
];
const MEETING_TITLES = [
  'Design critique', 'Customer call', 'Hiring sync', 'Roadmap review', 'Budget check-in', 'Sprint planning',
  'Retro', 'Vendor demo', 'Coffee chat', 'Board prep', 'Legal review', 'Metrics review', '1:1', 'Lunch',
  'Onboarding session', 'Incident postmortem',
];
const PLACES = [
  'Zoom', 'Conference Room A', 'Conference Room C', 'Blue Bottle, Hayes Valley', 'Office kitchen',
  'Google Meet', 'Cafe Strada', 'Room 4', 'Phone call', 'Sightglass, SoMa',
];
const NOTE_TOPICS = [
  'hiring pipeline', 'onboarding checklist', 'customer feedback', 'launch retro', 'vendor shortlist',
  'travel plans', 'reading list', 'gym schedule', 'apartment search', 'tax paperwork', 'conference talk outline',
  'weekly review',
];
const EMAIL_SUBJECTS = [
  'Re: invoice follow-up', 'Agenda for next week', 'Quick question about the contract', 'Intro: new vendor',
  'Notes from today', 'Can we move our sync?', 'Shared doc for review', 'Reminder: expense reports due',
  'Thanks for the update', 'Draft for your comments',
];
const FILE_KINDS = ['pdf', 'xlsx', 'docx', 'md', 'csv'];
const FILE_TOPICS = [
  'vendor contract', 'hiring plan', 'customer survey results', 'launch checklist', 'expense report',
  'office lease', 'retro notes', 'pricing analysis', 'travel itinerary', 'team offsite agenda',
];

export function generateCorpus(seed = 1): CorpusDoc[] {
  const rand = mulberry32(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const iso = (n: number): string => `2026-${String(int(8, 12)).padStart(2, '0')}-${String(n).padStart(2, '0')}`;

  const cal = JSON.parse(fs.readFileSync(path.join(SEED, 'calendar.json'), 'utf8')) as { events: SeedEvent[] };
  const con = JSON.parse(fs.readFileSync(path.join(SEED, 'contacts.json'), 'utf8')) as { contacts: SeedContact[] };

  const docs: CorpusDoc[] = [];
  const taken = new Set(con.contacts.map((c) => c.name));

  // Seed records first, same ids as workspace-seed.
  for (const c of con.contacts) {
    docs.push({
      id: c.id,
      text: `${c.name}. Email ${c.email}. Phone ${c.phone}. ${c.notes}`,
      metadata: { type: 'contact', date: '2026-10-01', people: c.name, title: c.name },
    });
    taken.add(c.name);
  }
  for (const e of cal.events) docs.push(calendarDoc(e));

  const notesDir = path.join(SEED, 'notes');
  for (const f of fs.readdirSync(notesDir).sort()) {
    const base = f.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(notesDir, f), 'utf8').trim();
    const people = con.contacts.map((c) => c.name).filter((n) => text.includes(n.split(' ')[0]!));
    docs.push({
      id: `note-${base}`,
      text,
      metadata: { type: 'note', date: /^\d{4}-\d{2}-\d{2}/.exec(base)?.[0] ?? '2026-10-20', people: people.join(', '), title: base },
    });
  }

  const filesDir = path.join(SEED, 'files');
  for (const f of fs.readdirSync(filesDir).sort()) {
    const stem = f.replace(/\.(xlsx\.txt|pdf)$/, '');
    const body = f.endsWith('.txt') ? fs.readFileSync(path.join(filesDir, f), 'utf8').trim() : '';
    const summary =
      stem === 'q3-deck'
        ? 'Q3 deck with the roadmap slide for the board. Reviewed with Priya Shah.'
        : 'Last year draft of the 2026 budget. Kept by Sam Rivera.';
    docs.push({
      id: `file-${stem}`,
      text: `File files/${f}. ${summary}${body ? ` Contents: ${body}` : ''}`,
      metadata: {
        type: 'file',
        date: '2026-10-20',
        people: stem === 'q3-deck' ? 'Priya Shah' : 'Sam Rivera',
        title: f,
      },
    });
  }

  // Filler. Never uses the name Priya.
  const people: string[] = [];
  const contactCount = 40;
  while (people.length < contactCount) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    if (taken.has(name)) continue;
    taken.add(name);
    people.push(name);
    const slug = name.toLowerCase().replace(' ', '.');
    docs.push({
      id: `contact-${slug.replace('.', '-')}`,
      text: `${name}. Email ${slug}@example.com. Phone +1-415-555-${String(int(0, 9999)).padStart(4, '0')}. ${pick(ROLES)}`,
      metadata: { type: 'contact', date: iso(int(1, 28)), people: name, title: name },
    });
  }
  const known = [...con.contacts.map((c) => c.name).filter((n) => n !== 'Priya Shah'), ...people];

  for (let i = 0; i < 150; i++) {
    const who = [pick(known)];
    if (rand() < 0.3) who.push(pick(known));
    const people2 = [...new Set(who)];
    const title = pick(MEETING_TITLES);
    const mo = int(8, 12);
    const d = int(1, 28);
    const h = int(9, 17);
    const mi = pick([0, 30]);
    const date = `2026-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const start = `${date}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00-07:00`;
    docs.push(
      calendarDoc({
        id: `evt-gen-${i}`,
        title: `${title} with ${people2.map((p) => p.split(' ')[0]).join(' and ')}`,
        start,
        end: start,
        attendees: people2,
        location: pick(PLACES),
      }),
    );
  }

  for (let i = 0; i < 60; i++) {
    const topic = pick(NOTE_TOPICS);
    const who = pick(known);
    const date = iso(int(1, 28));
    docs.push({
      id: `note-gen-${i}`,
      text: `Notes on ${topic}. Follow up with ${who} by next ${pick(DAYS)}. Open items: ${int(1, 6)}.`,
      metadata: { type: 'note', date, people: who, title: topic },
    });
  }

  for (let i = 0; i < 80; i++) {
    const from = pick(known);
    const subject = pick(EMAIL_SUBJECTS);
    docs.push({
      id: `email-gen-${i}`,
      text: `Email from ${from}. Subject: ${subject}. Sent ${pick(DAYS)} about ${pick(FILE_TOPICS)}.`,
      metadata: { type: 'email', date: iso(int(1, 28)), people: from, title: subject },
    });
  }

  for (let i = 0; i < 40; i++) {
    const topic = pick(FILE_TOPICS);
    const name = `${topic.replace(/ /g, '-')}-${i}.${pick(FILE_KINDS)}`;
    const owner = pick(known);
    docs.push({
      id: `file-gen-${i}`,
      text: `File files/${name}. Summary of the ${topic}, owned by ${owner}.`,
      metadata: { type: 'file', date: iso(int(1, 28)), people: owner, title: name },
    });
  }

  return docs;
}

function main(): void {
  const docs = generateCorpus();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(docs, null, 2) + '\n');
  console.log(`[corpus] wrote ${docs.length} docs`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
