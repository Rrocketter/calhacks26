export type CalendarEvent = { id: string; title: string; start: string; end?: string; [k: string]: unknown };
export type IndexEntry = { id: string; title: string; start: string; file: string };
export const CALENDAR_DIR: string;
export const INDEX_FILE: string;
export function eventFileName(id: string): string;
export function writeCalendarDir(events: CalendarEvent[], dir: string): number;
export function readCalendarDir(dir: string): CalendarEvent[];
export function readCalendar(parentDir: string): CalendarEvent[] | null;
export function countEventFiles(dir: string): number;
