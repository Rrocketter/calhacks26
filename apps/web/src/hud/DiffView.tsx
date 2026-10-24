import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseUnifiedDiff, type DiffLine } from './diff';

type Body = Extract<DiffLine, { oldNo: number | null }>;
const isBody = (l: DiffLine): l is Body => l.kind === 'add' || l.kind === 'del' || l.kind === 'ctx';
const SIGN = { add: '+', del: '-', ctx: ' ' } as const;

// Shared leading whitespace is dropped for display so long JSON lines fit the column.
function indentOf(lines: Body[]): number {
  const widths = lines.filter((l) => l.text.trim()).map((l) => l.text.length - l.text.replace(/^ +/, '').length);
  return widths.length ? Math.min(...widths) : 0;
}

// mark: red treatment with a tag (STALE, ROLLED BACK) and an optional note.
type Mark = { tag: string; note?: string } | null;

export function DiffView({ diffs, mark }: { diffs: { file: string; diff: string }[]; mark: Mark }) {
  const box = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const measure = () => {
    const el = box.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1);
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setClipped(el.scrollHeight > el.clientHeight + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className={['diffs', mark && 'stale', clipped && 'clipped'].filter(Boolean).join(' ')}>
      {diffs.map(({ file, diff }) => {
        const lines = parseUnifiedDiff(diff);
        const cut = indentOf(lines.filter(isBody));
        return (
          <div className="diff" key={file}>
            <div className="diff-file">
              <span className="num">{file}</span>
              {mark && <span className="tag bad">{mark.tag}</span>}
            </div>
            {mark?.note && <div className="stale-note">{mark.note}</div>}
            <div className="diff-body num">
              {lines.map((l, i) =>
                l.kind === 'meta' ? null : l.kind === 'hunk' ? (
                  <div className="dl hunk" key={i}>
                    {l.text}
                  </div>
                ) : (
                  <div className={`dl ${l.kind}`} key={i}>
                    <span className="ln">{l.newNo ?? l.oldNo}</span>
                    <span className="sign">{SIGN[l.kind]}</span>
                    <span className="code">{l.text.slice(cut)}</span>
                  </div>
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
