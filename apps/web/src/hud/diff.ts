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
