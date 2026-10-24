import type { HudState, ToolCall } from './state';

export type FeedRow =
  | { kind: 'plan'; text: string; done: boolean }
  | { kind: 'step'; text: string }
  | (ToolCall & { kind: 'tool'; status: 'pending' | 'ok' | 'error' });

// The live executor sends a step "<Tool> ok|error" per tool result.
const RESULT = /^(\S+) (ok|error)$/;

/**
 * Executor feed rows: plan items, other steps, then tool calls. Result steps mark the matching
 * call (the k-th "Read ok" belongs to the k-th allowed Read) instead of adding a row; results with
 * no call (TodoWrite, a denied call) are dropped. At most `max` rows: every denied row, then the
 * newest of the rest.
 */
export function feedRows(hud: Pick<HudState, 'plan' | 'steps' | 'tools'>, max: number): { rows: FeedRow[]; hidden: number } {
  const { plan, steps, tools } = hud;
  const calls: FeedRow[] = tools.map((t) => ({ ...t, kind: 'tool', status: 'pending' }));
  const extra: FeedRow[] = [];
  const used = new Map<string, number>();
  for (const text of steps) {
    if (plan.includes(text)) continue;
    const m = RESULT.exec(text);
    if (!m) {
      extra.push({ kind: 'step', text });
      continue;
    }
    const [, tool, status] = m;
    const k = used.get(tool) ?? 0;
    used.set(tool, k + 1);
    const call = calls.filter((c) => c.kind === 'tool' && c.tool === tool && !c.denied)[k];
    if (call?.kind === 'tool') call.status = status as 'ok' | 'error';
  }
  const all: FeedRow[] = [...plan.map((text) => ({ kind: 'plan' as const, text, done: steps.includes(text) })), ...extra, ...calls];
  if (all.length <= max) return { rows: all, hidden: 0 };
  const isDenied = (r: FeedRow) => r.kind === 'tool' && r.denied;
  let room = Math.max(0, max - all.filter(isDenied).length);
  const keep = new Set<FeedRow>();
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i];
    if (isDenied(r)) keep.add(r);
    else if (room > 0) {
      keep.add(r);
      room--;
    }
  }
  const rows = all.filter((r) => keep.has(r));
  return { rows, hidden: all.length - rows.length };
}
