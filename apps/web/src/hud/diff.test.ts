import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff';

// Copied from packages/contracts/mocks/droid.ts (DIFF is not exported).
const DIFF = `diff --git a/calendar.json b/calendar.json
index 8205574..e4ab07e 100644
--- a/calendar.json
+++ b/calendar.json
@@ -27,8 +27,8 @@
     {
       "id": "evt-priya-q3",
       "title": "Q3 deck review with Priya",
-      "start": "2026-10-30T14:00:00-07:00",
-      "end": "2026-10-30T15:00:00-07:00",
+      "start": "2026-11-02T09:00:00-08:00",
+      "end": "2026-11-02T10:00:00-08:00",
       "attendees": ["Priya Shah"],
       "location": "Conference Room B"
     },
`;

describe('parseUnifiedDiff', () => {
  const lines = parseUnifiedDiff(DIFF);
  const of = (kind: string) => lines.filter((l) => l.kind === kind);

  it('classifies meta, hunk, add and del lines', () => {
    expect(of('meta')).toHaveLength(4);
    expect(of('hunk')).toHaveLength(1);
    expect(of('del')).toHaveLength(2);
    expect(of('add')).toHaveLength(2);
    expect(of('ctx')).toHaveLength(6);
  });

  it('numbers lines from the hunk header', () => {
    expect(lines.find((l) => l.kind === 'ctx')).toMatchObject({ oldNo: 27, newNo: 27 });
    expect(lines.find((l) => l.kind === 'add')).toMatchObject({ oldNo: null, newNo: 30 });
    expect(lines.find((l) => l.kind === 'del')).toMatchObject({ oldNo: 30, newNo: null });
    expect(lines.at(-1)).toMatchObject({ kind: 'ctx', oldNo: 34, newNo: 34, text: '    },' });
  });

  it('strips the +/-/space prefix from body lines', () => {
    expect(lines.find((l) => l.kind === 'add')?.text).toBe('      "start": "2026-11-02T09:00:00-08:00",');
  });

  it('returns [] for an empty string', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('adds no line for a trailing newline', () => {
    expect(parseUnifiedDiff(DIFF.replace(/\n$/, ''))).toEqual(lines);
    expect(lines).toHaveLength(15);
  });
});
