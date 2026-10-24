// What Phase 1 hands Droid so it opens one small file instead of the whole calendar or contact list:
// the event file of the occurrence the belief points at, and the one contact it names.
import fs from 'node:fs';
import path from 'node:path';
import type { Belief } from '@ahead/contracts';

export type EventTarget = { id: string; title: string; start: string; file: string };
export type ContactTarget = Record<string, unknown> & { name: string };
export type Targets = { event?: EventTarget; contact?: ContactTarget };

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * The next occurrence (on or after today) of the event the belief points at: the event slot's
 * title if an indexed event has it, else the first Moss hit that is a workspace event. Null when
 * calendar/index.json is missing or nothing matches.
 */
export function eventTarget(belief: Belief, workspace: string, now: Date): EventTarget | null {
  const index = readJson<EventTarget[]>(path.join(workspace, 'calendar', 'index.json'));
  if (!index?.length) return null;
  const slot = belief.entities.event?.trim().toLowerCase();
  const byId = new Map(index.map((e) => [e.id, e]));
  const title =
    (slot ? index.find((e) => e.title.toLowerCase() === slot)?.title : undefined) ??
    belief.topHits.map((h) => byId.get(h.docId)?.title).find((t) => t !== undefined);
  if (!title) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const occurrences = index.filter((e) => e.title === title).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return occurrences.find((e) => Date.parse(e.start) >= today) ?? occurrences.at(-1) ?? null;
}

/** The contact the person slot names: full name first, else a unique first-name match. */
export function contactTarget(belief: Belief, workspace: string): ContactTarget | null {
  const person = belief.entities.person?.trim().toLowerCase();
  if (!person) return null;
  const contacts = readJson<{ contacts: ContactTarget[] }>(path.join(workspace, 'contacts.json'))?.contacts ?? [];
  const exact = contacts.find((c) => c.name.toLowerCase() === person);
  if (exact) return exact;
  const first = person.split(/\s+/)[0];
  const byFirst = contacts.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === first);
  return byFirst.length === 1 ? byFirst[0]! : null;
}

/** Targets for the belief's intent; computed once at Phase 1 and reused by Phase 2. */
export function targetsFor(belief: Belief, workspace: string, now: Date): Targets {
  if (belief.intent === 'reschedule_event') return { event: eventTarget(belief, workspace, now) ?? undefined };
  if (belief.intent === 'draft_message') return { contact: contactTarget(belief, workspace) ?? undefined };
  return {};
}
