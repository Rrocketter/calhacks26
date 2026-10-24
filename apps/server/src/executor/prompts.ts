// Phase 1 / Phase 2 prompts for the Droid executor. Templates live in src/actions/<intent>.md
// as two sections split by a `---PHASE2---` line; Phase 2 holds a {{slots}} placeholder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Belief, Intent } from '@ahead/contracts';
import type { Targets } from './targets.js';

const SEPARATOR = '\n---PHASE2---\n';
const TIMEZONE = 'America/Los_Angeles';
const SPECULATIVE = new Set<Intent>(['reschedule_event', 'draft_message', 'find_file', 'add_note']);

// R3: walk up from this file to the package root so it works from src (tsx) and dist.
function actionsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('server package root not found');
    dir = parent;
  }
  return path.join(dir, 'src', 'actions');
}

export function loadTemplate(intent: Intent): string {
  if (!SPECULATIVE.has(intent)) throw new Error(`no action template for intent: ${intent}`);
  return fs.readFileSync(path.join(actionsDir(), `${intent}.md`), 'utf8');
}

function sections(intent: Intent): [string, string] {
  const parts = loadTemplate(intent).split(SEPARATOR);
  if (parts.length !== 2) throw new Error(`template ${intent} needs exactly one ${SEPARATOR.trim()} line`);
  return [parts[0]!.trim(), parts[1]!.trim()];
}

// The event Phase 1 opens: the one file the server resolved, else the index to find it in.
function eventBlock(t: Targets): string {
  const e = t.event;
  if (e) {
    return `The event is ${oneLine(e.title)} on ${oneLine(e.start)}, in \`${e.file}\`. Open only this file: Read \`${e.file}\` and no other file under calendar/. In one step, call Read on it and TodoWrite with your plan together, in the same message.`;
  }
  return 'Read `calendar/index.json` (id, title, start and file of every event). Find the event the user means; a repeating event appears once per occurrence, so take the next occurrence on or after today. Then Read only that event\'s file. Note its `id`, `start` and `end`.';
}

function contactBlock(t: Targets): string {
  const c = t.contact;
  if (c) return `The recipient is this contact from contacts.json (do not open contacts.json): ${oneLine(JSON.stringify(c))}`;
  return 'Read contacts.json and find the person the user means.';
}

// `files` are workspace-relative paths under files/, listed by the server (Droid can't list dirs).
// `targets` (event file, contact) come from the belief, so Droid opens one small file.
export function phase1Prompt(belief: Belief, files: string[] = [], targets: Targets = {}): string {
  const list = files.length ? files.map(oneLine).join('\n') : '(no files)';
  return sections(belief.intent)[0]
    .replace('{{files}}', () => list)
    .replace('{{event}}', () => eventBlock(targets))
    .replace('{{contact}}', () => contactBlock(targets));
}

function todayLine(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `Today is ${parts.year}-${parts.month}-${parts.day} (${parts.weekday}), timezone ${TIMEZONE}.`;
}

// Newlines would let a value start a fake instruction line, so collapse them.
const oneLine = (s: string): string => s.replace(/\r?\n/g, ' ');

/** Entity key prefix the orchestrator sets when the user accepted a correction: `superseded_<field>` = what they first said. */
export const SUPERSEDED_PREFIX = 'superseded_';

export type Correction = { field: string; said: string; known: string };

/** Accepted corrections on a belief: the superseded value and the value that replaced it. */
export function corrections(belief: Belief): Correction[] {
  return Object.entries(belief.entities).flatMap(([k, said]) => {
    if (!k.startsWith(SUPERSEDED_PREFIX)) return [];
    const field = k.slice(SUPERSEDED_PREFIX.length);
    const known = belief.entities[field];
    return known && said ? [{ field, said, known }] : [];
  });
}

function renderSlots(entities: Record<string, string>): string {
  const lines = Object.entries(entities)
    .filter(([k]) => !k.startsWith(SUPERSEDED_PREFIX))
    .map(([k, v]) => `${oneLine(k)}: ${oneLine(v)}`);
  return lines.length ? lines.join('\n') : '(no details)';
}

function correctionLines(belief: Belief): string {
  return corrections(belief)
    .map(
      (c) =>
        `Correction: the user originally said ${oneLine(c.said)}, this was corrected to ${oneLine(c.known)}. Use ${oneLine(c.known)} only and do not mention ${oneLine(c.said)}.`,
    )
    .join('\n');
}

export function phase2Prompt(belief: Belief, now: Date = new Date(), targets: Targets = {}): string {
  const fixes = correctionLines(belief);
  const slots = renderSlots(belief.entities) + (fixes ? `\n\n${fixes}` : '');
  const file = targets.event ? `\`${targets.event.file}\`` : 'the event file you opened';
  const body = sections(belief.intent)[1]
    .replace('{{slots}}', () => slots)
    .replace('{{event_file}}', () => file);
  return `${todayLine(now)}\n\n${body}`;
}

/** The one rerun after a Phase 2 edit still mentioned a superseded value. */
export function correctionFixPrompt(belief: Belief, now: Date = new Date()): string {
  return [
    todayLine(now),
    '',
    'The file you just wrote still mentions a value the user corrected.',
    correctionLines(belief),
    'Edit that file so it does not mention the original value anywhere. Keep everything else the same.',
    'Stop immediately after the edit. Do not run commands. Do not touch files outside this workspace.',
  ].join('\n');
}

/**
 * The superseded value the added lines of `diffs` still mention, or null. Only values with a letter
 * are checked: a bare number like "2" also matches dates and times that are fine.
 */
export function mentionedSuperseded(diffs: { diff: string }[], belief: Belief): string | null {
  const added = diffs
    .flatMap((d) => d.diff.split('\n'))
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  for (const c of corrections(belief)) {
    if (!/[a-z]/i.test(c.said)) continue;
    if (new RegExp(`\\b${escapeRegExp(c.said)}\\b`, 'i').test(added)) return c.said;
  }
  return null;
}

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
