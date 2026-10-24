// Workspace calendar layout: one file per event, calendar/<event-id>.json, plus calendar/index.json
// (one { id, title, start, file } per line, sorted by start). Droid opens one event file instead
// of a 70 KB calendar.json. reset:workspace and pnpm import:google both write this shape.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CALENDAR_DIR = 'calendar';
export const INDEX_FILE = 'index.json';

// Event ids are Google or seed ids; anything outside [A-Za-z0-9._-] becomes '_'.
export function eventFileName(id) {
  return `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

// Replaces `dir` with one file per event and the index.
export function writeCalendarDir(events, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const e of events) writeFileSync(path.join(dir, eventFileName(e.id)), JSON.stringify(e, null, 2) + '\n');
  const index = events
    .map((e) => ({ id: e.id, title: e.title, start: e.start, file: `${CALENDAR_DIR}/${eventFileName(e.id)}` }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  writeFileSync(path.join(dir, INDEX_FILE), `[\n${index.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
  return index.length;
}

// All events of a calendar dir, in index order.
export function readCalendarDir(dir) {
  const index = JSON.parse(readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
  return index.map((x) => JSON.parse(readFileSync(path.join(dir, path.basename(x.file)), 'utf8')));
}

// Events from either shape: a calendar/ dir, or a legacy { events } calendar.json beside it.
export function readCalendar(parentDir) {
  const dir = path.join(parentDir, CALENDAR_DIR);
  if (existsSync(path.join(dir, INDEX_FILE))) return readCalendarDir(dir);
  const legacy = path.join(parentDir, 'calendar.json');
  if (existsSync(legacy)) return JSON.parse(readFileSync(legacy, 'utf8')).events;
  return null;
}

export function countEventFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json') && f !== INDEX_FILE).length;
}
