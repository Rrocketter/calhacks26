import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { changedSpans, parseUnifiedDiff, type DiffLine } from './diff';

type Body = Extract<DiffLine, { oldNo: number | null }>;
const isBody = (l: DiffLine): l is Body => l.kind === 'add' || l.kind === 'del' || l.kind === 'ctx';
const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

// Shared leading whitespace is dropped for display so long JSON lines fit the column.
function indentOf(lines: Body[]): number {
  const widths = lines.filter((l) => l.text.trim()).map((l) => l.text.length - l.text.replace(/^ +/, '').length);
  return widths.length ? Math.min(...widths) : 0;
}

function Code({ text, cut, span }: { text: string; cut: number; span?: [number, number] }) {
  if (!span || span[1] <= span[0]) return <span className="code">{text.slice(cut)}</span>;
  const [s, e] = [Math.max(cut, span[0]), Math.max(cut, span[1])];
  return (
    <span className="code">
      {text.slice(cut, s)}
      <span className="chg">{text.slice(s, e)}</span>
      {text.slice(e)}
    </span>
  );
}

// mark: dimmed treatment with a tag (STALE, ROLLED BACK) and an optional note.
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
        const spans = changedSpans(lines);
        const cut = indentOf(lines.filter(isBody));
        const adds = lines.filter((l) => l.kind === 'add').length;
        const dels = lines.filter((l) => l.kind === 'del').length;
        let row = 0;
        return (
          <div className="diff" key={file}>
            <div className="diff-file">
              <span className="num file">{file}</span>
              <span className="num stat">
                <span className="plus">+{adds}</span>
                <span className="minus">−{dels}</span>
              </span>
              {mark && <span className="tag bad">{mark.tag}</span>}
            </div>
            {mark?.note && <div className="stale-note">{mark.note}</div>}
            <div className="diff-body num" key={diff}>
              {lines.map((l, i) =>
                l.kind === 'meta' ? null : l.kind === 'hunk' ? (
                  <div className="dl hunk" key={i} style={{ '--i': row++ } as CSSProperties}>
                    {l.text}
                  </div>
                ) : (
                  <div className={`dl ${l.kind}`} key={i} style={{ '--i': row++ } as CSSProperties}>
                    <span className="ln">{l.oldNo}</span>
                    <span className="ln">{l.newNo}</span>
                    <span className="sign">{SIGN[l.kind]}</span>
                    <Code text={l.text} cut={cut} span={spans.get(i)} />
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
