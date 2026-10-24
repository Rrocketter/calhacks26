import { normalize } from './normalize.js';

/** Title words that name the kind of event, not its topic. The last one in a title is its kind. */
const KINDS = new Set([
  'meeting', 'review', 'call', 'sync', 'lecture', 'discussion', 'class', 'exam', 'midterm', 'final',
  'session', 'interview', 'appointment', 'standup', 'seminar', 'lab', 'office', 'hours',
]);
/** Title words never used as a topic on their own. */
const GENERIC = new Set([...KINDS, 'group', 'project', 'team', 'weekly', 'the', 'a', 'an', 'and', 'of', 'for', 'with', 'at', 'on', 'in', 'to', 'my', 'due']);

const titleTokens = (title: string) => title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Title words (original casing, title order) the user also said, other than generic words and the
 * attendees' names: "VQE" for "VQE Project Group Meeting" in "...present the VQE results...".
 */
export function topicWords(title: string | undefined, normText: string, people = ''): string[] {
  if (!title) return [];
  const said = new Set(normText.split(' '));
  const names = new Set(normalize(people).split(' ').filter(Boolean));
  return titleTokens(title).filter((t) => {
    const n = normalize(t);
    return n.length >= 2 && !GENERIC.has(n) && !names.has(n) && said.has(n);
  });
}

/** How the interject names the event: "the VQE meeting" (topic + kind), else "the <title>". */
export function eventPhrase(title: string | undefined, normText: string, people = ''): string {
  if (!title) return 'that event';
  const topic = topicWords(title, normText, people);
  const kind = [...titleTokens(title)].reverse().find((t) => KINDS.has(normalize(t)));
  // Acronyms and codes keep their case ("VQE", "Q3"); ordinary title-case words read lower case.
  const spoken = topic.map((t) => (t === t.toUpperCase() || /\d/.test(t) ? t : t.toLowerCase()));
  if (topic.length && kind) return `the ${spoken.join(' ')} ${kind.toLowerCase()}`;
  const generic = titleTokens(title).every((t) => GENERIC.has(normalize(t)));
  return `the ${generic ? title.toLowerCase() : title}`;
}

/** A time the way it is spoken in the interject: "8:30 pm" -> "8:30", "2 pm" -> "2". */
export function spokenTime(time: string | undefined): string {
  return (time ?? '').replace(/\s*[ap]\.?m\.?$/i, '').trim();
}
