import { useEffect, useRef, useState } from 'react';
import type { HudState } from './state';
import { Sparkline, Tween, useSeries } from './motion';

const LOCK = 0.75;

export function BeliefPanel({ hud }: { hud: HudState }) {
  const b = hud.belief;
  const intent = b?.intent ?? 'unknown';
  const conf = b?.confidence ?? 0;
  const locked = conf >= LOCK;
  const entities = Object.entries(b?.entities ?? {});
  const hits = (b?.topHits ?? []).slice(0, 3);
  const series = useSeries(hud.moss.count, hud.moss.lastMs);
  // One pulse on the LOCK line each time confidence crosses it upward.
  const [crossings, setCrossings] = useState(0);
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (locked && !wasLocked.current) setCrossings((n) => n + 1);
    wasLocked.current = locked;
  }, [locked]);
  return (
    <section className="panel belief">
      <div className="panel-head">
        <span className="label">
          <span className="idx">02</span>Belief
        </span>
        {b?.latencyMs.llm !== undefined && <span className="ms num">llm {Math.round(b.latencyMs.llm)} ms</span>}
      </div>
      {/* Underscores as spaces so long intents wrap on words; never truncated */}
      <div className="intent-wrap">
        <div className={intent === 'unknown' ? 'intent unknown' : 'intent'} key={intent}>
          {intent.replace(/_/g, ' ')}
        </div>
      </div>
      <div className={locked ? 'conf locked' : 'conf'}>
        <div className="conf-track">
          <div className="conf-zone" style={{ left: `${LOCK * 100}%` }} />
          <div className="conf-fill" style={{ width: `${Math.min(100, Math.max(0, conf * 100))}%` }} />
          <div className="conf-tick" style={{ left: `${LOCK * 100}%` }}>
            <span className="label">Lock {LOCK.toFixed(2)}</span>
            {crossings > 0 && <span className="lock-pulse" key={crossings} />}
          </div>
        </div>
        <span className="conf-value num">
          <Tween value={conf} digits={2} />
        </span>
      </div>
      {entities.length > 0 && (
        <div className="chips">
          {entities.map(([k, v]) => (
            <span className="chip" key={`${k}:${v}`}>
              <span className="k">{k}</span>
              {v}
            </span>
          ))}
        </div>
      )}
      {b && b.claims.length > 0 && (
        <div className="section">
          {b.claims.map((c, i) => (
            <div className="claim" key={`${i}:${c.said}:${c.known}`}>
              <span className="k">{c.field}</span>
              <span className="said">{c.said}</span>
              <span className="arrow" aria-hidden />
              <span className="known">{c.known}</span>
              <span className="src num">{c.docId}</span>
            </div>
          ))}
        </div>
      )}
      <div className="section hits">
        <div className="hits-head">
          <span className="label">Moss</span>
          <span className="qcount num">
            <Tween value={hud.moss.count} ms={250} />
            <span className="unit">queries</span>
          </span>
          <Sparkline values={series} />
          {hud.moss.lastMs !== null && (
            <span className="ms num tick" key={hud.moss.count}>
              {hud.moss.lastMs.toFixed(1)} ms
            </span>
          )}
        </div>
        {hits.length === 0 && <span className="empty">No hits yet</span>}
        {hits.map((h, i) => (
          // By doc, so a newly retrieved doc slides in; a repeated docId falls back to its index.
          <div className="hit" key={hits.findIndex((x) => x.docId === h.docId) === i ? h.docId : `${h.docId}#${i}`}>
            <div className="hit-head">
              <span className="doc">{h.docId}</span>
              <span className="score num">
                <span className="score-bar">
                  <span style={{ width: `${Math.min(100, Math.max(0, h.score * 100))}%` }} />
                </span>
                {h.score.toFixed(2)}
              </span>
            </div>
            <div className="snippet">{h.snippet}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
