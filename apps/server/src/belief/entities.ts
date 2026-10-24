export type FastEntities = { person?: string; day?: string; time?: string; file?: string };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function resolveDay(day: string, today: Date): { weekday: string; date_iso: string } {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let offset = 0;
  if (day === 'tomorrow') {
    offset = 1;
  } else if (day !== 'today') {
    const target = WEEKDAYS.indexOf(day);
    if (target < 0) throw new Error(`unknown day: ${day}`);
    offset = (target - base.getDay() + 7) % 7;
  }
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  return { weekday: WEEKDAYS[d.getDay()]!, date_iso: isoLocal(d) };
}

const DAY_RE = new RegExp(`\\b(${[...WEEKDAYS, 'today', 'tomorrow'].join('|')})\\b`);
const TIME_AT_RE = /\bat (\d{1,2})(?: (pm|am))?\b/;
const TIME_MERIDIEM_RE = /\b(\d{1,2}) (pm|am)\b/;
const FILE_RE = /\b(q\d deck|budget)\b/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeEntityExtractor(
  contacts: { name: string }[],
): (normalizedText: string) => FastEntities {
  const matchers = contacts.map((c) => {
    const full = c.name.toLowerCase().trim();
    const first = full.split(/\s+/)[0] ?? full;
    return {
      name: c.name,
      re: new RegExp(`\\b(?:${escapeRe(full)}|${escapeRe(first)})\\b`),
    };
  });

  return (text) => {
    const out: FastEntities = {};
    const person = matchers.find((m) => m.re.test(text));
    if (person) out.person = person.name;
    const day = DAY_RE.exec(text);
    if (day) out.day = day[1]!;
    const t = TIME_AT_RE.exec(text) ?? TIME_MERIDIEM_RE.exec(text);
    if (t) out.time = t[2] ? `${t[1]} ${t[2]}` : t[1]!;
    const file = FILE_RE.exec(text);
    if (file) out.file = file[1]!;
    return out;
  };
}
