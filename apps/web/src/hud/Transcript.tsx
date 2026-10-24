import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import { words, type HudState } from './state';

// Keyed by index and text, so new words and Ink's rewrites ("two" → "2") animate in, the rest stay put.
function Words({ text, highlight, callout }: { text: string; highlight: number | null; callout?: ReactNode }) {
  const ws = words(text);
  const anchored = highlight !== null && highlight < ws.length;
  return (
    <>
      {ws.map((w, i) => (
        <Fragment key={`${i}:${w}`}>
          {i > 0 && ' '}
          <span className="w">{i === highlight ? <mark>{w}</mark> : w}</span>
          {i === highlight && callout}
        </Fragment>
      ))}
      {!anchored && callout}
    </>
  );
}

// The interjection, inserted into the sentence right where the agent cut in, pointing at the word.
function Callout({ text }: { text: string }) {
  const box = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const word = el?.previousElementSibling?.querySelector('mark');
    if (!el) return;
    if (!(word instanceof HTMLElement)) {
      el.style.removeProperty('--x');
      return;
    }
    el.style.setProperty('--x', `${Math.max(14, word.offsetLeft + word.offsetWidth / 2 - el.offsetLeft)}px`);
  });
  return (
    <span className="callout" ref={box}>
      <span className="label">
        <span className="cut-icon" aria-hidden />
        AHEAD cut in
      </span>
      <span className="callout-text">{text}</span>
    </span>
  );
}

export function Transcript({ hud, error }: { hud: HudState; error: string | null }) {
  const { turnId, partial, finals, interject, eagerEnd } = hud;
  const open = turnId !== null && !finals.some((f) => f.turnId === turnId);
  // The just-finished sentence stays large until the next turn speaks.
  const last = finals.at(-1);
  const current = turnId !== null && last?.turnId === turnId && partial === '' ? last : null;
  const older = current ? finals.slice(0, -1) : finals;
  const highlight = interject && interject.turnId === turnId ? interject.wordIndex : null;
  const callout = interject && <Callout key={`${interject.turnId}-${interject.text}`} text={interject.text} />;
  return (
    <section className="panel transcript" aria-live="polite">
      {error && (
        <div className="error-banner" role="alert" title={error}>
          {error}
        </div>
      )}
      <div className="panel-head">
        <span className="label">
          <span className="idx">01</span>Transcript
        </span>
        {eagerEnd && open && <span className="tag">EAGER END</span>}
        {open && !eagerEnd && partial !== '' && <span className="tag live">HEARING</span>}
      </div>
      {older.length > 0 && (
        <div className="finals">
          {older.map((f, i) => (
            <div key={`${f.turnId}-${i}`}>
              <Words text={f.text} highlight={f.highlight} />
            </div>
          ))}
        </div>
      )}
      {open ? (
        <div className="partial">
          <Words text={partial} highlight={highlight} callout={callout} />
          <span className="caret" />
        </div>
      ) : current ? (
        <div className="partial">
          <Words text={current.text} highlight={current.highlight} callout={callout} />
        </div>
      ) : (
        finals.length === 0 && (
          <div className="partial idle">
            <span className="idle-dot" />
            Waiting for speech
          </div>
        )
      )}
      {!open && !current && callout}
    </section>
  );
}
