import { words, type HudState } from './state';

function Words({ text, highlight }: { text: string; highlight: number | null }) {
  return (
    <>
      {words(text).map((w, i) => (
        <span key={i}>
          {i > 0 && ' '}
          {i === highlight ? <mark>{w}</mark> : w}
        </span>
      ))}
    </>
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
  return (
    <section className="panel" aria-live="polite">
      {error && (
        <div className="error-banner" role="alert" title={error}>
          {error}
        </div>
      )}
      <div className="panel-head">
        <span className="label">Transcript</span>
        {eagerEnd && open && <span className="tag">EAGER END</span>}
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
          <Words text={partial} highlight={highlight} />
          <span className="caret" />
        </div>
      ) : current ? (
        <div className="partial">
          <Words text={current.text} highlight={current.highlight} />
        </div>
      ) : (
        finals.length === 0 && <div className="partial idle">Waiting for speech</div>
      )}
      {interject && (
        <div className="interject" key={`${interject.turnId}-${interject.text}`}>
          <span className="label">Interjected</span>
          <span className="text">{interject.text}</span>
        </div>
      )}
    </section>
  );
}
