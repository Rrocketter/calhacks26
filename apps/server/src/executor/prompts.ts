// Phase 1 / Phase 2 prompts for the Droid executor. Templates live in src/actions/<intent>.md
// as two sections split by a `---PHASE2---` line; Phase 2 holds a {{slots}} placeholder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Belief, Intent } from '@ahead/contracts';

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

export function phase1Prompt(belief: Belief): string {
  return sections(belief.intent)[0];
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

function renderSlots(entities: Record<string, string>): string {
  const lines = Object.entries(entities).map(([k, v]) => `${k}: ${v}`);
  return lines.length ? lines.join('\n') : '(no details)';
}

export function phase2Prompt(belief: Belief, now: Date = new Date()): string {
  const body = sections(belief.intent)[1].replace('{{slots}}', () => renderSlots(belief.entities));
  return `${todayLine(now)}\n\n${body}`;
}
