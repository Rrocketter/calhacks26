export type DiffLine =
  | { kind: 'meta'; text: string } // diff --git, index, ---, +++
  | { kind: 'hunk'; text: string } // @@ … @@
  | { kind: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const raw = diff.split('\n');
  if (raw.at(-1) === '') raw.pop();
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const [i, line] of raw.entries()) {
    // A new file header ends the hunk, with or without a leading `diff --git`.
    if (line.startsWith('diff --git') || (line.startsWith('--- ') && raw[i + 1]?.startsWith('+++ '))) inHunk = false;
    const h = HUNK.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: line });
    } else if (!inHunk || line.startsWith('\\')) {
      // File header lines, or "\ No newline at end of file".
      out.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else {
      out.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

const WORD = /[A-Za-z0-9]/;

// [start, end) of the part of `a` that differs from `b`, widened to whole words.
function span(a: string, b: string): [number, number] {
  if (a === b) return [0, 0];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  let start = pre;
  let end = a.length - suf;
  while (start > 0 && WORD.test(a[start - 1]!)) start--;
  while (end < a.length && WORD.test(a[end]!)) end++;
  return [start, end];
}

/**
 * Character spans that changed inside paired lines: in each run of dels followed by the same
 * number of adds, the k-th del pairs with the k-th add. Keyed by index into `lines`.
 */
export function changedSpans(lines: DiffLine[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const d0 = i;
    while (i < lines.length && lines[i]!.kind === 'del') i++;
    const a0 = i;
    while (i < lines.length && lines[i]!.kind === 'add') i++;
    const n = a0 - d0;
    if (i - a0 !== n) continue;
    for (let k = 0; k < n; k++) {
      const d = lines[d0 + k]!.text;
      const a = lines[a0 + k]!.text;
      out.set(d0 + k, span(d, a));
      out.set(a0 + k, span(a, d));
    }
  }
  return out;
}
