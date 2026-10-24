// Pure shaping for import-google.ts: Google Calendar / Gmail API objects in, the same
// shapes gen-corpus produces out. No I/O, so it is tested against fixture JSON.
import type { CorpusDoc } from '../src/belief/types.js';
import { calendarDoc, type SeedContact, type SeedEvent } from './gen-corpus.js';

// The subset of the googleapis response types we read.
export type GAttendee = { email?: string | null; displayName?: string | null; self?: boolean | null; resource?: boolean | null };
export type GTime = { dateTime?: string | null; date?: string | null };
export type GEvent = {
  id?: string | null;
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
  if (!n || n.includes('@')) return prettify(email);
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

export function shapeEvents(items: GEvent[], tz: string): SeedEvent[] {
  return items
    .filter((e) => e.id && e.status !== 'cancelled' && (e.start?.dateTime || e.start?.date))
    .map((e) => ({
      id: `g-evt-${e.id}`,
      title: e.summary?.trim() || '(no title)',
      start: when(e.start, tz),
      end: when(e.end ?? e.start, tz),
      attendees: (e.attendees ?? [])
        .filter((a) => a.email && !a.self && !a.resource)
        .map((a) => personName(a.displayName, a.email!)),
      location: e.location?.trim() ?? '',
    }));
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
    const ms = Number(m.internalDate) || Date.parse(header('date')) || 0;
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

export function deriveContacts(events: GEvent[], emails: ShapedEmail[], selfEmail: string): SeedContact[] {
  const self = selfEmail.toLowerCase();
  const seen = new Map<string, { name: string; events: number; threads: number }>();
  const add = (p: Person, kind: 'events' | 'threads'): void => {
    if (!p.email || p.email === self || NO_REPLY.test(p.email)) return;
    const c = seen.get(p.email) ?? { name: p.name, events: 0, threads: 0 };
    c[kind]++;
    seen.set(p.email, c);
  };
  for (const e of events) {
    if (e.status === 'cancelled') continue;
    for (const a of e.attendees ?? []) {
      if (a.email && !a.self && !a.resource) {
        const email = a.email.toLowerCase();
        add({ name: personName(a.displayName, email), email }, 'events');
      }
    }
  }
  for (const m of emails) add(m.from, 'threads');

  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
  const ids = new Set<string>();
  return [...seen].map(([email, c]) => {
    const base = `g-contact-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'}`;
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
    ids.add(id);
    const notes = [c.events && plural(c.events, 'event'), c.threads && plural(c.threads, 'email thread')].filter(Boolean);
    return { id, name: c.name, email, phone: '', notes: `${notes.join(', ')}.` };
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

export function toCorpus(events: SeedEvent[], contacts: SeedContact[], emails: ShapedEmail[]): CorpusDoc[] {
  const known = new Map<string, string>();
  for (const m of emails) for (const p of [m.from, ...m.to]) if (!m.fromSelf || p !== m.from) known.set(p.email, p.name);
  for (const c of contacts) known.set(c.email, c.name);
  const r = (s: string): string => redactEmails(s, known);

  // Most recent date each person shows up, for contact doc metadata.
  const last = new Map<string, string>();
  const touch = (name: string, date: string): void => {
    if ((last.get(name) ?? '') < date) last.set(name, date);
  };
  for (const e of events) for (const a of e.attendees) touch(a, e.start.slice(0, 10));
  for (const m of emails) for (const p of m.fromSelf ? m.to : [m.from]) touch(p.name, m.date);

  const docs: CorpusDoc[] = [];
  for (const c of contacts) {
    docs.push({
      id: c.id,
      text: `${c.name}. ${c.notes}`,
      metadata: { type: 'contact', date: last.get(c.name) ?? '', people: c.name, title: c.name },
    });
  }
  for (const e of events) docs.push(calendarDoc({ ...e, title: r(e.title), location: r(e.location) }));
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
