import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@ahead/contracts';
import { feedRows } from './feed';
import { hudReducer, initialHud } from './state';

const droid = (kind: 'plan' | 'step' | 'tool' | 'diff' | 'result', payload: unknown, denied?: boolean): ServerEvent => ({
  type: 'droid_event',
  turnId: 't1',
  kind,
  payload,
  denied,
  ts: 0,
});

describe('feedRows', () => {
  it('folds tool results into their tool rows and caps the feed', () => {
    const events: ServerEvent[] = [droid('plan', { steps: ['Read calendar.json', 'Edit event'] })];
    events.push(droid('tool', { tool: 'Read', path: '../../.env', denied: true, reason: 'outside-workspace' }, true));
    for (let i = 0; i < 7; i++) {
      events.push(droid('tool', { tool: 'Read', path: `f${i}.json` }));
      events.push(droid('step', { text: i === 6 ? 'Read error' : 'Read ok' }));
    }
    events.push(droid('step', { text: 'TodoWrite ok' }));
    events.push(droid('step', { text: 'Read calendar.json' }));
    events.push(droid('diff', { file: 'calendar.json', diff: '+x' }));
    events.push(droid('result', { ok: true, summary: 'done' }));
    const s = events.reduce(hudReducer, initialHud());
    expect(s.diffs).toHaveLength(1);
    expect(s.result?.ok).toBe(true);

    const { rows, hidden } = feedRows(s, 5);
    expect(rows).toHaveLength(5);
    expect(hidden).toBe(5);
    expect(rows.some((r) => r.kind === 'step')).toBe(false); // no "Read ok" rows
    expect(rows[0]).toMatchObject({ kind: 'tool', denied: true }); // denied always kept
    expect(rows.at(-1)).toMatchObject({ kind: 'tool', path: 'f6.json', status: 'error' });
    expect(rows.at(-2)).toMatchObject({ kind: 'tool', path: 'f5.json', status: 'ok' });

    const all = feedRows(s, 100);
    expect(all.hidden).toBe(0);
    expect(all.rows[0]).toMatchObject({ kind: 'plan', text: 'Read calendar.json', done: true });
    expect(all.rows[1]).toMatchObject({ kind: 'plan', text: 'Edit event', done: false });
  });

  it('keeps steps that are not tool results', () => {
    const s = [droid('step', { text: 'Edit event' })].reduce(hudReducer, initialHud());
    expect(feedRows(s, 5).rows).toEqual([{ kind: 'step', text: 'Edit event' }]);
  });
});
