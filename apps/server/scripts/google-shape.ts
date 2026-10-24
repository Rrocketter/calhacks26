// Pure shaping for import-google.ts: Google Calendar / Gmail API objects in, the same
// shapes gen-corpus produces out. No I/O, so it is tested against fixture JSON.
import type { CorpusDoc } from '../src/belief/types.js';
import { calendarDoc, type SeedEvent } from './gen-corpus.js';

// The subset of the googleapis response types we read.
export type GAttendee = { email?: string | null; displayName?: string | null; self?: boolean | null; resource?: boolean | null };
export type GTime = { dateTime?: string | null; date?: string | null };
export type GCalendar = {
  id?: string | null;
  summary?: string | null;
  summaryOverride?: string | null;
  primary?: boolean | null;
  accessRole?: string | null;
};
// `calendar` is not a Google field: import-google.ts tags each event with its calendar label.
export type GEvent = {
  id?: string | null;
  calendar?: string | null;
  status?: string | null;
  summary?: string | null;
  location?: string | null;
  start?: GTime | null;
  end?: GTime | null;
  attendees?: GAttendee[] | null;
};
export type GPart = {
  mimeType?: string | null;
  filename?: string | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  body?: { data?: string | null } | null;
  parts?: GPart[] | null;
};
export type GMessage = { id?: string | null; internalDate?: string | null; snippet?: string | null; payload?: GPart | null };
export type GThread = { id?: string | null; messages?: GMessage[] | null };

export type Person = { name: string; email: string };
export type ShapedEvent = SeedEvent & { calendar: string };
// Name only: no email or phone ever lands in contacts.json.
export type GContact = { id: string; name: string; notes: string; sources: string[] };
// CorpusDoc (belief/types.ts) plus the calendar label; build-index passes extra metadata through.
export type GCorpusDoc = Omit<CorpusDoc, 'metadata'> & { metadata: CorpusDoc['metadata'] & { calendar?: string } };
export type ShapedEmail = {
  id: string;
  subject: string;
  from: Person;
  to: Person[];
  fromSelf: boolean;
  date: string;
  day: string;
  body: string;
};

export const SUBJECT_BLOCKLIST = /receipt|password|verification code|statement/i;
const NO_REPLY = /no-?reply|notifications?@|mailer-daemon/i;
const BODY_CHARS = 500;
const EMAIL = '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}';

function prettify(email: string): string {
  return email
    .split('@')[0]!
    .split(/[._+-]+/)
    .map((w) => w.replace(/\d+/g, ''))
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function personName(displayName: string | null | undefined, email: string): string {
  const n = (displayName ?? '').replace(/^"|"$/g, '').trim();
  // A display name that carries an address or domain ("John (john at corp.com)") is not used.
  if (!n || n.includes('@') || /\b[\w-]+\.(com|org|net|edu|io)\b/i.test(n)) return prettify(email);
  const parts = n.split(',').map((s) => s.trim());
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : n;
}

// "A, B" <a@x>, c@y -> [{name, email}], splitting on commas outside quotes and angle brackets.
export function parseAddresses(header: string): Person[] {
  const out: Person[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of header + ',') {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) {
      const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(cur);
      const email = (m ? m[2]! : cur).trim().toLowerCase();
      if (email.includes('@')) out.push({ name: personName(m?.[1], email), email });
      cur = '';
    } else cur += ch;
  }
  return out;
}

function offset(date: string, tz: string): string {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${date}T12:00:00Z`))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  return name === 'GMT' ? '+00:00' : name.slice(3);
}

function when(t: GTime | null | undefined, tz: string): string {
  if (t?.dateTime) return t.dateTime;
  if (t?.date) return `${t.date}T00:00:00${offset(t.date, tz)}`;
  throw new Error('event without start/end');
}

// Primary is "primary"; a calendar named after an address is labeled by its domain, so no
// address ever reaches metadata or logs.
export function calendarLabel(c: GCalendar): string {
  if (c.primary) return 'primary';
  const name = (c.summaryOverride || c.summary || c.id || 'calendar').trim();
  const at = name.lastIndexOf('@');
  if (at >= 0 && !name.includes(' ')) return name.slice(at + 1);
  return name.includes('@') ? redactEmails(name, new Map()) : name;
}

export function parseExclude(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Owner or writer calendars only; read-only subscriptions (holidays, shared groups) are skipped.
// `exclude` matches the label or the calendar's own name, case-insensitive.
export function selectCalendars(
  list: GCalendar[],
  exclude: string[],
): { kept: { id: string; label: string }[]; readOnly: number; excluded: string[] } {
  const kept: { id: string; label: string }[] = [];
  const excluded: string[] = [];
  let readOnly = 0;
  for (const c of list) {
    if (!c.id) continue;
    if (c.accessRole !== 'owner' && c.accessRole !== 'writer') {
      readOnly++;
      continue;
    }
    const label = calendarLabel(c);
    const names = [label, c.summary, c.summaryOverride].map((n) => (n ?? '').trim().toLowerCase());
    if (names.some((n) => n && exclude.includes(n))) excluded.push(label);
    else kept.push({ id: c.id, label });
  }
  return { kept, readOnly, excluded };
}

const NOT_NAMES = new Set(['team', 'group', 'everyone', 'all', 'me', 'us', 'them', 'friends', 'family', 'lab']);

// "Pulsar Project with Hayk & Luka" -> ["Hayk", "Luka"]. Only capitalized one- or two-word
// pieces after "with" / "w/", up to any bracket, colon, pipe, or dash separator.
export function namesFromTitle(title: string): string[] {
  const m = /\b(?:with|w\/)\s+(.+)$/i.exec(title);
  if (!m) return [];
  const tail = m[1]!.split(/\s+[-–—|]\s+|[([:|]/)[0]!;
  return tail
    .split(/\s*(?:,|&|\+|\/|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter((p) => /^\p{Lu}[\p{L}'’-]*(?: \p{Lu}[\p{L}'’-]*)?$/u.test(p) && !NOT_NAMES.has(p.toLowerCase()));
}

function uniqueEvents(items: GEvent[]): GEvent[] {
  const seen = new Set<string>();
  return items.filter((e) => {
    if (!e.id || e.status === 'cancelled' || !(e.start?.dateTime || e.start?.date) || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

function realAttendees(e: GEvent, self: string): string[] {
  return (e.attendees ?? [])
    .filter((a) => a.email && !a.self && !a.resource && a.email.toLowerCase() !== self)
    .map((a) => personName(a.displayName, a.email!))
    .filter(Boolean);
}

// An event on two calendars (shared invite) is kept once, from the first calendar listed.
// Events with no other attendees take people from the title; a first name that matches
// exactly one known attendee's first name becomes that full name.
export function shapeEvents(items: GEvent[], tz: string, selfEmail = ''): ShapedEvent[] {
  const self = selfEmail.toLowerCase();
  const events = uniqueEvents(items);
  const full = [...new Set(events.flatMap((e) => realAttendees(e, self)))].filter((n) => n.includes(' '));
  const resolve = (n: string): string => {
    if (n.includes(' ')) return n;
    const hits = full.filter((f) => f.split(' ')[0]!.toLowerCase() === n.toLowerCase());
    return hits.length === 1 ? hits[0]! : n;
  };
  return events.map((e) => {
    const real = realAttendees(e, self);
    // calendar.json is read by Droid, so it gets the same address/link redaction as the corpus.
    const title = redactEmails(e.summary?.trim() || '(no title)', new Map());
    return {
      id: `g-evt-${e.id}`,
      title,
      start: when(e.start, tz),
      end: when(e.end ?? e.start, tz),
      attendees: real.length ? real : [...new Set(namesFromTitle(title).map(resolve))],
      location: redactEmails(e.location?.trim() ?? '', new Map()),
      calendar: e.calendar ?? 'primary',
    };
  });
}

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function entities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(html: string): string {
  return entities(html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

// First text/plain part, else first text/html, skipping attachments.
function findBody(p: GPart | null | undefined, mime: string): string | undefined {
  if (!p || p.filename) return undefined;
  if (p.mimeType === mime && p.body?.data) return decode(p.body.data);
  for (const c of p.parts ?? []) {
    const b = findBody(c, mime);
    if (b) return b;
  }
  return undefined;
}

function localDate(ms: number, tz: string): { date: string; day: string } {
  const d = new Date(ms);
  return {
    date: new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d),
    day: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d).toLowerCase(),
  };
}

export function shapeThreads(threads: GThread[], selfEmail: string, tz: string): { kept: ShapedEmail[]; skipped: number } {
  const self = selfEmail.toLowerCase();
  const kept: ShapedEmail[] = [];
  let skipped = 0;
  for (const t of threads) {
    const m = t.messages?.[0];
    if (!t.id || !m) continue;
    const header = (n: string): string =>
      m.payload?.headers?.find((h) => h.name?.toLowerCase() === n)?.value ?? '';
    const subject = header('subject').trim();
    if (SUBJECT_BLOCKLIST.test(subject)) {
      skipped++;
      continue;
    }
    const from = parseAddresses(header('from'))[0] ?? { name: 'Unknown', email: '' };
    const plain = findBody(m.payload, 'text/plain');
    const html = plain ? undefined : findBody(m.payload, 'text/html');
    const raw = plain ?? (html ? stripHtml(html) : entities(m.snippet ?? ''));
    const ms = Number(m.internalDate) || Date.parse(header('date'));
    if (!ms) continue;
    kept.push({
      id: t.id,
      subject: subject || '(no subject)',
      from,
      to: parseAddresses(header('to')).filter((p) => p.email !== self),
      fromSelf: from.email === self,
      ...localDate(ms, tz),
      body: raw.replace(/\s+/g, ' ').trim().slice(0, BODY_CHARS),
    });
  }
  return { kept, skipped };
}

// People from event attendees (or titles) and email senders, keyed by name. Self and
// no-reply senders are left out. Only names, counts, and sources are kept.
export function deriveContacts(events: ShapedEvent[], emails: ShapedEmail[], selfEmail: string): GContact[] {
  const self = selfEmail.toLowerCase();
  const seen = new Map<string, { name: string; events: number; threads: number; sources: Set<string> }>();
  const add = (name: string, kind: 'events' | 'threads', source: string): void => {
    const key = name.toLowerCase();
    const c = seen.get(key) ?? { name, events: 0, threads: 0, sources: new Set<string>() };
    c[kind]++;
    c.sources.add(source);
    seen.set(key, c);
  };
  for (const e of events) for (const a of e.attendees) add(a, 'events', e.calendar);
  for (const m of emails) {
    if (m.from.name && m.from.email && m.from.email !== self && !NO_REPLY.test(m.from.email)) add(m.from.name, 'threads', 'gmail');
  }

  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
  const ids = new Set<string>();
  return [...seen.values()].map((c) => {
    const base = `g-contact-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'}`;
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
    ids.add(id);
    const notes = [c.events && plural(c.events, 'event'), c.threads && plural(c.threads, 'email thread')].filter(Boolean);
    return { id, name: c.name, notes: `${notes.join(', ')}.`, sources: [...c.sources] };
  });
}

// Addresses become the person's name (or [email]), links become [link].
export function redactEmails(text: string, known: Map<string, string>): string {
  const name = (addr: string): string => known.get(addr.toLowerCase()) ?? '[email]';
  return text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]')
    .replace(new RegExp(`"([^"]*)"\\s*<${EMAIL}>`, 'gi'), '$1')
    .replace(new RegExp(`(\\w)\\s*<${EMAIL}>`, 'gi'), '$1')
    .replace(new RegExp(`<(${EMAIL})>`, 'gi'), (_, a: string) => name(a))
    .replace(new RegExp(EMAIL, 'gi'), (a) => name(a))
    .replace(/\S*@\S+/g, '[email]');
}

export function toCorpus(events: ShapedEvent[], contacts: GContact[], emails: ShapedEmail[]): GCorpusDoc[] {
  const known = new Map<string, string>();
  for (const m of emails) for (const p of [m.from, ...m.to]) if (!m.fromSelf || p !== m.from) known.set(p.email, p.name);
  const r = (s: string): string => redactEmails(s, known);

  // Most recent date each person shows up, for contact doc metadata.
  const last = new Map<string, string>();
  const touch = (name: string, date: string): void => {
    if ((last.get(name) ?? '') < date) last.set(name, date);
  };
  for (const e of events) for (const a of e.attendees) touch(a, e.start.slice(0, 10));
  for (const m of emails) for (const p of m.fromSelf ? m.to : [m.from]) touch(p.name, m.date);

  const docs: GCorpusDoc[] = [];
  for (const c of contacts) {
    docs.push({
      id: c.id,
      text: `${c.name}. ${c.notes}`,
      metadata: { type: 'contact', date: last.get(c.name) ?? '', people: c.name, title: c.name },
    });
  }
  for (const e of events) {
    const d = calendarDoc({ ...e, title: r(e.title), location: r(e.location) });
    docs.push({ ...d, metadata: { ...d.metadata, calendar: e.calendar } });
  }
  for (const m of emails) {
    const people = m.fromSelf ? m.to.map((p) => p.name) : [m.from.name];
    const who = m.fromSelf ? `me to ${people.join(', ') || 'myself'}` : m.from.name;
    const subject = r(m.subject);
    const body = r(m.body);
    docs.push({
      id: `g-email-${m.id}`,
      text: `Email from ${who}. Subject: ${subject}. Sent ${m.day}.${body ? ` ${body}` : ''}`,
      metadata: { type: 'email', date: m.date, people: people.join(', '), title: subject },
    });
  }
  return docs;
}
