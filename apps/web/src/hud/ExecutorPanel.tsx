import type { HudState } from './state';
import { Stepper } from './Stepper';
import { DiffView } from './DiffView';
import { feedRows } from './feed';

// canSend: a transport is up (live socket open, or mock).
type Props = { hud: HudState; canSend: boolean; onConfirm(apply: boolean): void };

// Rows beyond this would squeeze the diff and push Apply / Discard out of the panel.
const FEED_MAX = 6;

export function ExecutorPanel({ hud, canSend, onConfirm }: Props) {
  const { plan, steps, tools, diffs, result } = hud;
  const { rows, hidden } = feedRows(hud, FEED_MAX);
  const idle = hud.droidTurnId === null && plan.length + steps.length + tools.length + diffs.length === 0 && !result;
  // The server rolls back a live spec on the next turn but only says LISTENING for the new one.
  const prior = hud.droidTurnId !== null && hud.droidTurnId !== hud.stateTurnId;
  const rolledBack = !prior && hud.state === 'ROLLED_BACK';
  const canConfirm = canSend && !prior && (hud.state === 'SPECULATING' || hud.state === 'STAGED');
  const stale = result?.failed === true;
  const mark =
    stale && result ? { tag: 'STALE', note: result.summary } : rolledBack ? { tag: 'ROLLED BACK' } : null;
  return (
    <section className={prior ? 'panel executor prior' : 'panel executor'}>
      <div className="panel-head">
        <span className="label">Executor</span>
        {prior && <span className="tag dim">PREVIOUS TURN</span>}
      </div>
      <Stepper hud={hud} />
      {idle ? (
        <span className="empty">No speculation yet</span>
      ) : (
        <>
          {rows.length > 0 && (
            <ul className="feed">
              {hidden > 0 && <li className="row more num">+{hidden} earlier</li>}
              {rows.map((r, i) =>
                r.kind === 'tool' ? (
                  <li
                    className={['row tool', r.denied && 'denied', r.status === 'ok' && 'done'].filter(Boolean).join(' ')}
                    key={i}
                  >
                    {r.denied ? (
                      <span className="tag bad">DENIED</span>
                    ) : (
                      <span className="check">{r.status === 'ok' ? '✓' : r.status === 'error' ? '✕' : '○'}</span>
                    )}
                    <span className="num">{r.tool}</span>
                    {r.path && <span className="num path">{r.path}</span>}
                    {r.denied && r.reason && <span className="reason">{r.reason}</span>}
                  </li>
                ) : (
                  <li className={r.kind === 'step' || r.done ? 'row done' : 'row'} key={i}>
                    <span className="check">{r.kind === 'step' || r.done ? '✓' : '○'}</span>
                    {r.text}
                  </li>
                ),
              )}
            </ul>
          )}
          {diffs.length > 0 ? (
            <DiffView diffs={diffs} mark={mark} />
          ) : (
            <div className="diffs-spacer">
              {stale && result && (
                <div className="result">
                  <span className="tag bad">STALE</span>
                  {result.summary}
                </div>
              )}
            </div>
          )}
          {result && !stale && (
            <div className={result.ok ? 'result ok' : 'result'}>
              <span className="check">{result.ok ? '✓' : '✕'}</span>
              {result.summary}
            </div>
          )}
        </>
      )}
      <div className="confirm">
        <button className="btn primary" disabled={!canConfirm} onClick={() => onConfirm(true)}>
          Apply
        </button>
        <button className="btn" disabled={!canConfirm} onClick={() => onConfirm(false)}>
          Discard
        </button>
        <span className="hint">or say "yes"</span>
      </div>
    </section>
  );
}
