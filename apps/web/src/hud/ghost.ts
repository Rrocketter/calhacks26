import type { Belief } from '@ahead/contracts';

// Below this the guess is noise: the ghost fades out entirely. At the lock line it is fully shown.
export const GHOST_MIN = 0.3;
const GHOST_FULL = 0.75;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const join = (...xs: (string | undefined)[]) => xs.filter(Boolean).join(' ');

/**
 * What the belief implies the rest of the sentence is, as segments joined by ▸ in the HUD:
 * draft_message {person: 'Priya Shah', day: 'friday', time: '2 pm', topic: 'Q3 review'}
 * → ['draft to Priya Shah', 'about Friday 2 PM Q3 review']. A claim's `known` value wins over
 * the entity it corrects, since that is what the agent will act on. Null when there is no guess.
 */
export function ghostParts(belief: Belief | null): string[] | null {
  if (!belief || belief.intent === 'unknown') return null;
  const e = belief.entities;
  const known = (field: string) => belief.claims.find((c) => c.field === field)?.known;
  const day = known('day') ?? e.weekday ?? e.day;
  const time = (known('time') ?? e.time)?.replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
  const when = join(day && cap(day), time);
  const person = known('person') ?? e.person;
  const topic = known('topic') ?? e.topic;
  const file = known('file') ?? e.file;
  const tail = (prefix: string, rest: string) => (rest ? [`${prefix} ${rest}`] : []);
  switch (belief.intent) {
    case 'draft_message':
      return [person ? `draft to ${person}` : 'draft a message', ...tail('about', join(when, topic))];
    case 'reschedule_event':
      // Without to_weekday the day said is the meeting's current one, not where it is going.
      return [
        join('move', topic ?? 'the meeting', person && `with ${person}`),
        ...tail('to', e.to_weekday ? join(cap(e.to_weekday), time) : ''),
      ];
    case 'find_file':
      return [`find ${file ?? topic ?? 'a file'}`, ...tail('from', person ?? '')];
    case 'add_note':
      return [topic ? `note ${topic}` : 'add a note', ...tail('for', when)];
    case 'lookup':
      return [`look up ${topic ?? person ?? file ?? 'that'}`, ...tail('for', when)];
  }
}

/** 0 at GHOST_MIN or below, 1 at the lock line, linear between. */
export function ghostOpacity(confidence: number): number {
  return Math.min(1, Math.max(0, (confidence - GHOST_MIN) / (GHOST_FULL - GHOST_MIN)));
}
