import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import { isMemoryHit, panelHits, type HudState } from './state';
import { Sparkline, Tween, useSeries } from './motion';
import { intentLabel, productChips } from './cards';
import { ghostOpacity, ghostParts } from './ghost';
import type { View } from './Stepper';

const LOCK = 0.75;

export function BeliefPanel({ hud, view }: { hud: HudState; view: View }) {
  const b = hud.belief;
  const product = view === 'product';
  const intent = b?.intent ?? 'unknown';
  const conf = b?.confidence ?? 0;
  const locked = conf >= LOCK;
  const entities = Object.entries(b?.entities ?? {});
  const chips = productChips(b?.entities ?? {});
  const hits = panelHits(b?.topHits ?? []);
  const series = useSeries(hud.moss.count, hud.moss.lastMs);
  const avg = hud.moss.count ? hud.moss.totalMs / hud.moss.count : null;
  const ghost = ghostParts(b);
  const ghostO = b ? ghostOpacity(b.confidence) : 0;
  // "How it knows": open in Engineering, closed in Product; a click overrides until the view flips.
  const [override, setOverride] = useState<{ view: View; open: boolean } | null>(null);
  const open = override?.view === view ? override.open : !product;
  // One pulse on the LOCK line each time confidence crosses it upward.
  const [crossings, setCrossings] = useState(0);
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (locked && !wasLocked.current) setCrossings((n) => n + 1);
    wasLocked.current = locked;
  }, [locked]);
  const label = product ? intentLabel(b) : intent.replace(/_/g, ' ');
  return (
    <section className="panel belief">
      <div className="panel-head">
        <span className="label">
          <span className="idx">02</span>
          {product ? 'Understanding' : 'Belief'}
        </span>
        {!product && b?.latencyMs.llm !== undefined && <span className="ms num">llm {Math.round(b.latencyMs.llm)} ms</span>}
      </div>
      {/* Underscores as spaces so long intents wrap on words; never truncated */}
      <div className="intent-wrap">
        <div className={intent === 'unknown' ? 'intent unknown' : 'intent'} key={`${view}:${label}`}>
          {label}
        </div>
      </div>
      <div className={locked ? 'conf locked' : 'conf'}>
        <div className="conf-track">
          <div className="conf-zone" style={{ left: `${LOCK * 100}%` }} />
          <div className="conf-fill" style={{ width: `${Math.min(100, Math.max(0, conf * 100))}%` }} />
          <div className="conf-tick" style={{ left: `${LOCK * 100}%` }}>
            <span className="label">{product ? 'Sure enough to act' : `Lock ${LOCK.toFixed(2)}`}</span>
            {crossings > 0 && <span className="lock-pulse" key={crossings} />}
          </div>
        </div>
        <span className="conf-value num">
          {product ? (
            <>
              <Tween value={conf * 100} />%
            </>
          ) : (
            <Tween value={conf} digits={2} />
          )}
        </span>
      </div>
      {product
        ? chips.length > 0 && (
            <div className="chips">
              {chips.map((c) => (
                <span className={c.was ? 'chip fixed' : 'chip'} key={`${c.key}:${c.value}`}>
                  <span className="k">{c.label}</span>
                  {c.was && <s className="was">{c.was}</s>}
                  {c.value}
                </span>
              ))}
            </div>
          )
        : entities.length > 0 && (
            <div className="chips">
              {entities.map(([k, v]) => (
                <span className="chip" key={`${k}:${v}`}>
                  <span className="k">{k}</span>
                  {v}
                </span>
              ))}
            </div>
          )}
      {ghost && ghostO > 0 && (
        // Mounted in both views (hidden in Engineering) so a view flip does not move the panel.
        <div className="belief-ghost eng-hidden" style={{ '--ghost': ghostO } as CSSProperties}>
          <span className="ghost-tag">predicting</span>
          {ghost.map((p, i) => (
            <Fragment key={`${i}:${p}`}>
              {i > 0 && <span className="ghost-sep">▸</span>}
              <span className="ghost-part">{p}</span>
            </Fragment>
          ))}
        </div>
      )}
      <div className={open ? 'how open' : 'how'}>
        <button className="how-head" aria-expanded={open} onClick={() => setOverride({ view, open: !open })}>
          <span className="how-caret" aria-hidden />
          <span className="how-title">How it knows</span>
          <span className="how-sum num">
            Moss · {hud.moss.count} {hud.moss.count === 1 ? 'query' : 'queries'}
            {avg !== null && ` · ${avg.toFixed(1)} ms avg`}
            {b && b.claims.length > 0 && ` · ${b.claims.length} ${b.claims.length === 1 ? 'correction' : 'corrections'}`}
          </span>
        </button>
        <div className="how-body" inert={!open}>
          <div className="how-inner">
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
                <div className={isMemoryHit(h) ? 'hit memory' : 'hit'} key={hits.findIndex((x) => x.docId === h.docId) === i ? h.docId : `${h.docId}#${i}`}>
                  <div className="hit-head">
                    <span className="doc">
                      {isMemoryHit(h) && <span className="tag-memory">memory</span>}
                      {h.docId}
                    </span>
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
          </div>
        </div>
      </div>
    </section>
  );
}
