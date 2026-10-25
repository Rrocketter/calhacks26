import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Belief } from '@ahead/contracts';
import { words, type HudState, type Interject, type Reply } from './state';
import { ghostOpacity, ghostParts } from './ghost';

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
  const place = () => {
    const el = box.current;
    if (!el) return;
    const word = el.previousElementSibling?.querySelector('mark');
    if (!(word instanceof HTMLElement)) {
      el.style.removeProperty('--x');
      return;
    }
    el.style.setProperty('--x', `${Math.max(14, word.offsetLeft + word.offsetWidth / 2 - el.offsetLeft)}px`);
  };
  useLayoutEffect(place);
  // Re-aim after a resize or the web font swapping in, with no new transcript events.
  useEffect(() => {
    addEventListener('resize', place);
    void document.fonts?.ready.then(place);
    return () => removeEventListener('resize', place);
  }, []);
  return (
    <span className="callout" ref={box}>
      <span className="label">
        <span className="cut-icon" aria-hidden />
        Ahem cut in
      </span>
      <span className="callout-text">{text}</span>
    </span>
  );
}

// Dim guess at the rest of the sentence from the belief; each segment re-animates when it changes.
function Ghost({ belief }: { belief: Belief }) {
  const parts = ghostParts(belief);
  const o = ghostOpacity(belief.confidence);
  if (!parts || o === 0) return null;
  return (
    <span className="ghost" style={{ '--ghost': o } as CSSProperties} aria-hidden>
      {parts.map((p, i) => {
        // The tag stays glued to the first word so it never ends a line on its own.
        const cut = i === 0 ? p.indexOf(' ') : -1;
        const lead = cut < 0 ? p : p.slice(0, cut);
        return (
          <Fragment key={`${i}:${p}`}>
            {i > 0 && <span className="ghost-sep">▸</span>}
            <span className="ghost-part">
              {i === 0 ? (
                <span className="ghost-lead">
                  <span className="ghost-tag">predicting</span>
                  {lead}
                </span>
              ) : (
                p
              )}
              {cut >= 0 && p.slice(cut)}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

// What Ahem said for a turn, captioned under it so nothing spoken is lost in a noisy room.
// An interject still on screen as the callout is not repeated.
function Captions({ replies, turnId, callout }: { replies: Reply[]; turnId: string; callout: Interject | null }) {
  const shown = replies.filter(
    (r) => r.turnId === turnId && !(r.kind === 'interject' && callout?.turnId === turnId && callout.text === r.text),
  );
  if (shown.length === 0) return null;
  return (
    <div className="captions">
      {shown.map((r) => (
        <div className={`caption ${r.kind}`} key={r.seq}>
          <span className="caption-who">Ahem</span>
          {r.text}
        </div>
      ))}
    </div>
  );
}

// The reducer keeps the last belief across turns; only one that arrived during this turn counts.
function useTurnBelief(turnId: string | null, belief: Belief | null): Belief | null {
  const [seen, setSeen] = useState({ turnId, stale: belief });
  if (seen.turnId !== turnId) setSeen({ turnId, stale: belief });
  return seen.turnId === turnId && belief !== seen.stale ? belief : null;
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
  const belief = useTurnBelief(turnId, hud.belief);
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
        {eagerEnd && open && <span className="tag">Eager end</span>}
        {open && !eagerEnd && partial !== '' && <span className="tag live">Hearing</span>}
      </div>
      {older.length > 0 && (
        <div className="finals">
          {older.map((f, i) => (
            <div key={`${f.turnId}-${i}`}>
              <Words text={f.text} highlight={f.highlight} />
              <Captions replies={hud.replies} turnId={f.turnId} callout={null} />
            </div>
          ))}
        </div>
      )}
      {open ? (
        <div className="partial">
          <Words text={partial} highlight={highlight} callout={callout} />
          <span className="caret" />
          {belief && partial !== '' && <Ghost belief={belief} />}
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
      {turnId !== null && (open || current) && <Captions replies={hud.replies} turnId={turnId} callout={interject} />}
    </section>
  );
}
