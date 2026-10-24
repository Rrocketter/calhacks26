import type { HudState } from './state';

const LOCK = 0.75;

export function BeliefPanel({ hud }: { hud: HudState }) {
  const b = hud.belief;
  const intent = b?.intent ?? 'unknown';
  const conf = b?.confidence ?? 0;
  const entities = Object.entries(b?.entities ?? {});
  const hits = (b?.topHits ?? []).slice(0, 3);
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="label">Belief</span>
        {b && (
          <span className="ms num">
            moss {b.latencyMs.moss.toFixed(1)} ms
            {b.latencyMs.llm !== undefined && ` · llm ${Math.round(b.latencyMs.llm)} ms`}
          </span>
        )}
      </div>
      {/* Underscores as spaces so long intents wrap on words; never truncated */}
      <div className={intent === 'unknown' ? 'intent unknown' : 'intent'}>{intent.replace(/_/g, ' ')}</div>
      <div className="conf">
        <div className="conf-track">
          <div className="conf-fill" style={{ width: `${Math.min(100, Math.max(0, conf * 100))}%` }} />
          <div className="conf-tick" style={{ left: `${LOCK * 100}%` }}>
            <span className="label">Lock</span>
          </div>
        </div>
        <span className={conf >= LOCK ? 'conf-value num locked' : 'conf-value num'}>{conf.toFixed(2)}</span>
      </div>
      {entities.length > 0 && (
        <div className="chips">
          {entities.map(([k, v]) => (
            <span className="chip" key={k}>
              <span className="k">{k}</span>
              {v}
            </span>
          ))}
        </div>
      )}
      {b && b.claims.length > 0 && (
        <div className="section">
          {b.claims.map((c, i) => (
            <div className="claim" key={i}>
              <span className="k">{c.field}</span>
              <span className="said">{c.said}</span>
              <span>→</span>
              <span className="known">{c.known}</span>
            </div>
          ))}
        </div>
      )}
      <div className="section hits">
        <span className="label">Top hits</span>
        {hits.length === 0 && <span className="empty">No hits yet</span>}
        {hits.map((h) => (
          <div className="hit" key={h.docId}>
            <div className="hit-head">
              <span className="doc">{h.docId}</span>
              <span className="score num">{h.score.toFixed(2)}</span>
            </div>
            <div className="snippet">{h.snippet}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
