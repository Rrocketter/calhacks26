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

export function Transcript({ hud }: { hud: HudState }) {
  const { turnId, partial, finals, interject, eagerEnd } = hud;
  const open = turnId !== null && !finals.some((f) => f.turnId === turnId);
  const highlight = interject && interject.turnId === turnId ? interject.wordIndex : null;
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="label">Transcript</span>
        {eagerEnd && <span className="tag">EAGER END</span>}
      </div>
      {finals.length > 0 && (
        <div className="finals">
          {finals.map((f, i) => (
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
