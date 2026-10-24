import type { Belief } from '@ahead/contracts';
import type { HudState } from './state';
import { parseUnifiedDiff } from './diff';

// Product mode: the staged result rendered as the thing it is (a mail draft, a calendar tile),
// built only from what the events already carry.

export type CardInput = Pick<HudState, 'turnId' | 'belief' | 'diffs' | 'result' | 'tools' | 'finals' | 'replies'>;

export type When = { day: string; time: string; end: string | null };
export type Card =
  | { kind: 'message'; file: string; to: string | null; subject: string | null; body: string; highlight: string[] }
  | { kind: 'event'; file: string; title: string | null; location: string | null; before: When; after: When }
  | { kind: 'note'; file: string; title: string | null; lines: string[] }
  | { kind: 'file'; path: string | null; name: string; type: string | null; why: string | null }
  | { kind: 'answer'; question: string; answer: string | null };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The file as it reads after the diff: context and added lines, in order. */
export function newFileText(diff: string): string {
  return parseUnifiedDiff(diff)
    .flatMap((l) => (l.kind === 'add' || l.kind === 'ctx' ? [l.text] : []))
    .join('\n');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** Day and time as written in the event (its own offset), so the browser's zone never shifts it. */
export function wallTime(iso: string): { day: string; time: string } | null {
  const m = ISO.exec(iso);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { day: `${DAYS[dow]}, ${MONTHS[mo - 1]} ${d}`, time: `${h12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` };
}

export function intentLabel(belief: Belief | null): string {
  const e = belief?.entities ?? {};
  switch (belief?.intent ?? 'unknown') {
    case 'draft_message':
      return e.person ? `Drafting a message to ${e.person}` : 'Drafting a message';
    case 'reschedule_event':
      return `Moving: ${e.event ?? e.topic ?? 'a meeting'}`;
    case 'find_file':
      return `Finding: ${e.file ?? e.topic ?? 'a file'}`;
    case 'add_note':
      return e.topic ? `Writing a note: ${e.topic}` : 'Writing a note';
    case 'lookup': {
      const what = e.topic ?? e.event ?? e.person ?? e.file;
      return what ? `Looking up: ${what}` : 'Answering a question';
    }
    default:
      return 'Listening';
  }
}

export type Chip = { key: string; label: string; value: string; was?: string };

const SUPERSEDED = 'superseded_'; // apps/server executor/prompts.ts SUPERSEDED_PREFIX
const LABELS: Record<string, string> = {
  person: 'Who',
  event: 'Event',
  topic: 'About',
  day: 'Day',
  weekday: 'Day',
  time: 'Time',
  to_weekday: 'New day',
  to_time: 'New time',
  file: 'File',
};
// Internal or derived: the date ISO strings, the drafted body, a weekday that repeats the day said.
const hidden = (k: string, e: Record<string, string>) =>
  k.startsWith(SUPERSEDED) || k.endsWith('_iso') || k === 'message' || (k === 'weekday' && e.day !== undefined);
// Day names come lowercase from the normalizer; names and titles keep their case.
const tidy = (k: string, v: string) => (k === 'day' || k.endsWith('weekday') ? cap(v) : v);

/** Entity chips for Product mode, with the value a correction replaced. */
export function productChips(entities: Record<string, string>): Chip[] {
  return Object.entries(entities)
    .filter(([k]) => !hidden(k, entities))
    .map(([k, v]) => {
      const chip: Chip = { key: k, label: LABELS[k] ?? cap(k.replace(/_/g, ' ')), value: tidy(k, v) };
      const was = entities[`${SUPERSEDED}${k}`];
      if (was !== undefined && was !== v) chip.was = tidy(k, was);
      return chip;
    });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text split into plain and marked runs: whole-word, case-insensitive matches of `marks`. */
export function highlightSegments(text: string, marks: string[]): { text: string; mark: boolean }[] {
  const ws = marks.map((m) => m.trim()).filter(Boolean);
  if (ws.length === 0) return [{ text, mark: false }];
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${ws.map(escape).join('|')})(?![A-Za-z0-9])`, 'gi');
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), mark: false });
    out.push({ text: m[0], mark: true });
    at = m.index + m[0].length;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), mark: false });
  return out;
}

// What the agent corrected: each claim's known value, and any entity that replaced a superseded one.
function corrections(belief: Belief | null): string[] {
  if (!belief) return [];
  const e = belief.entities;
  const out = new Set(belief.claims.map((c) => cap(c.known)));
  for (const k of Object.keys(e)) {
    const field = k.startsWith(SUPERSEDED) ? k.slice(SUPERSEDED.length) : null;
    if (field && e[field]) out.add(tidy(field, e[field]));
  }
  return [...out];
}

function messageCard(file: string, diff: string, belief: Belief | null): Card | null {
  const lines = newFileText(diff).split('\n');
  let to: string | null = null;
  let subject: string | null = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^(To|Subject):\s*(.*)$/i.exec(lines[i]!);
    if (!m) break;
    if (m[1]!.toLowerCase() === 'to') to = m[2]!.trim();
    else subject = m[2]!.trim();
  }
  const body = lines.slice(i).join('\n').trim();
  if (!body && !to) return null;
  return { kind: 'message', file, to: to || belief?.entities.person || null, subject, body, highlight: corrections(belief).filter((w) => new RegExp(`\\b${escape(w)}\\b`, 'i').test(body)) };
}

const FIELD = /^\s*"(\w+)":\s*"([^"]*)"/;

function eventCard(file: string, diff: string, belief: Belief | null): Card | null {
  const old: Record<string, string> = {};
  const now: Record<string, string> = {};
  for (const l of parseUnifiedDiff(diff)) {
    if (l.kind === 'meta' || l.kind === 'hunk') continue;
    const m = FIELD.exec(l.text);
    if (!m) continue;
    if (l.kind !== 'add') old[m[1]!] = m[2]!;
    if (l.kind !== 'del') now[m[1]!] = m[2]!;
  }
  const when = (f: Record<string, string>): When | null => {
    const s = f.start ? wallTime(f.start) : null;
    if (!s) return null;
    return { ...s, end: (f.end && wallTime(f.end)?.time) || null };
  };
  const before = when(old);
  const after = when(now);
  if (!before || !after || old.start === now.start) return null;
  return { kind: 'event', file, title: now.title ?? belief?.entities.event ?? belief?.entities.topic ?? null, location: now.location || null, before, after };
}

function noteCard(file: string, diff: string): Card | null {
  const lines = newFileText(diff).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const head = lines[0]!.startsWith('#') ? lines[0]!.replace(/^#+\s*/, '') : null;
  return { kind: 'note', file, title: head, lines: (head === null ? lines : lines.slice(1)).map((l) => l.replace(/^[-*]\s+/, '')) };
}

const FILE_PATH = /files\/[\w./-]*\w/;

function fileType(name: string): string | null {
  // "budget-2026.xlsx.txt" is a spreadsheet exported as text: the first extension names it.
  const ext = name.split('.').slice(1)[0];
  return ext ? ext.toUpperCase() : null;
}

function fileCard(input: CardInput): Card | null {
  const summary = input.result?.summary ?? '';
  const inSummary = FILE_PATH.exec(summary);
  const read = [...input.tools].reverse().find((t) => !t.denied && t.path && FILE_PATH.test(t.path));
  const path = inSummary?.[0] ?? (read?.path ? FILE_PATH.exec(read.path)![0] : null);
  if (path) {
    const name = path.split('/').at(-1)!;
    const why = inSummary ? summary.slice(inSummary.index + path.length).replace(/^[\s.,:;`'"—-]+/, '').trim() || null : null;
    return { kind: 'file', path, name, type: fileType(name), why };
  }
  const named = input.belief?.entities.file ?? input.belief?.entities.topic;
  return named ? { kind: 'file', path: null, name: named, type: null, why: null } : null;
}

function answerCard(input: CardInput): Card | null {
  const { turnId } = input;
  const question = input.finals.filter((f) => f.turnId === turnId).at(-1)?.text;
  const answer = input.replies.filter((r) => r.turnId === turnId && r.kind === 'answer').at(-1)?.text ?? null;
  return question ? { kind: 'answer', question, answer } : null;
}

/** The card for what is staged (or answered) right now, or null when there is nothing to render. */
export function buildCard(input: CardInput): Card | null {
  const { belief, diffs } = input;
  if (belief?.intent === 'lookup') return answerCard(input);
  for (const { file, diff } of diffs) {
    const card = file.startsWith('messages/')
      ? messageCard(file, diff, belief)
      : file.startsWith('calendar')
        ? eventCard(file, diff, belief)
        : file.startsWith('notes/')
          ? noteCard(file, diff)
          : null;
    if (card) return card;
  }
  if (diffs.length === 0 && belief?.intent === 'find_file') return fileCard(input);
  return null;
}
