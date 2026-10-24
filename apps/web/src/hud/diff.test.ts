import { describe, expect, it } from 'vitest';
import { changedSpans, parseUnifiedDiff } from './diff';

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

  const body = (d: string) =>
    parseUnifiedDiff(d).flatMap((l) => ('oldNo' in l ? [[l.kind, l.oldNo, l.newNo, l.text]] : []));

  it('restarts numbering at each hunk header', () => {
    const d = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -10,1 +10,2 @@\n j\n+k\n';
    expect(body(d)).toEqual([
      ['ctx', 1, 1, 'a'],
      ['del', 2, null, 'b'],
      ['add', null, 2, 'B'],
      ['ctx', 10, 10, 'j'],
      ['add', null, 11, 'k'],
    ]);
  });

  it('treats a second file header as meta', () => {
    const d =
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+X\n' +
      'diff --git a/y b/y\nindex 1..2 100644\n--- a/y\n+++ b/y\n@@ -5 +5 @@\n-y\n+Y\n';
    const lines = parseUnifiedDiff(d);
    expect(lines.filter((l) => l.kind === 'meta')).toHaveLength(7);
    expect(body(d)).toEqual([
      ['del', 1, null, 'x'],
      ['add', null, 1, 'X'],
      ['del', 5, null, 'y'],
      ['add', null, 5, 'Y'],
    ]);
  });

  it('ends the hunk at a headerless ---/+++ pair', () => {
    const d = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+X\n--- a/y\n+++ b/y\n@@ -3 +3 @@\n-y\n+Y\n';
    expect(parseUnifiedDiff(d).filter((l) => l.kind === 'meta').map((l) => l.text)).toEqual([
      '--- a/x',
      '+++ b/x',
      '--- a/y',
      '+++ b/y',
    ]);
    expect(body(d)).toEqual([
      ['del', 1, null, 'x'],
      ['add', null, 1, 'X'],
      ['del', 3, null, 'y'],
      ['add', null, 3, 'Y'],
    ]);
  });

  it('keeps "\\ No newline at end of file" as meta without advancing numbers', () => {
    const d = '--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n-a\n\\ No newline at end of file\n+a\n+b\n';
    const lines = parseUnifiedDiff(d);
    expect(lines).toContainEqual({ kind: 'meta', text: '\\ No newline at end of file' });
    expect(body(d)).toEqual([
      ['del', 1, null, 'a'],
      ['add', null, 1, 'a'],
      ['add', null, 2, 'b'],
    ]);
  });

  it('numbers a new file from 1', () => {
    const d = 'diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+one\n+two\n';
    expect(body(d)).toEqual([
      ['add', null, 1, 'one'],
      ['add', null, 2, 'two'],
    ]);
  });

  it('accepts count-less hunk headers', () => {
    expect(body('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n')).toEqual([
      ['del', 1, null, 'a'],
      ['add', null, 1, 'b'],
    ]);
  });
});

describe('changedSpans', () => {
  it('marks only the differing middle of paired del/add lines', () => {
    const lines = parseUnifiedDiff(DIFF);
    const spans = changedSpans(lines);
    const del = lines.findIndex((l) => l.kind === 'del');
    const add = lines.findIndex((l) => l.kind === 'add');
    const d = lines[del]!.text;
    const a = lines[add]!.text;
    const [ds, de] = spans.get(del)!;
    const [as, ae] = spans.get(add)!;
    expect(d.slice(ds, de)).toBe('10-30T14:00:00-07');
    expect(a.slice(as, ae)).toBe('11-02T09:00:00-08');
    expect(spans.has(lines.findIndex((l) => l.kind === 'ctx'))).toBe(false);
  });

  it('leaves unpaired adds whole', () => {
    const lines = parseUnifiedDiff('@@ -1,1 +1,2 @@\n a\n+b\n');
    expect(changedSpans(lines).size).toBe(0);
  });
});
