import type { HudState } from './state';
import { Stepper } from './Stepper';
import { DiffView } from './DiffView';

type Props = { hud: HudState; onConfirm(apply: boolean): void };

export function ExecutorPanel({ hud, onConfirm }: Props) {
  const { plan, steps, tools, diffs, result } = hud;
  const extra = steps.filter((s) => !plan.includes(s));
  const idle = hud.droidTurnId === null && plan.length + steps.length + tools.length + diffs.length === 0 && !result;
  const canConfirm = hud.state === 'SPECULATING' || hud.state === 'STAGED';
  const stale = result?.failed === true;
  return (
    <section className="panel executor">
      <div className="panel-head">
        <span className="label">Executor</span>
      </div>
      <Stepper hud={hud} />
      {idle ? (
        <span className="empty">No speculation yet</span>
      ) : (
        <>
          {(plan.length > 0 || extra.length > 0 || tools.length > 0) && (
            <ul className="feed">
              {plan.map((p, i) => {
                const done = steps.includes(p);
                return (
                  <li className={done ? 'row done' : 'row'} key={`p${i}`}>
                    <span className="check">{done ? '✓' : '○'}</span>
                    {p}
                  </li>
                );
              })}
              {extra.map((s, i) => (
                <li className="row done" key={`x${i}`}>
                  <span className="check">✓</span>
                  {s}
                </li>
              ))}
              {tools.map((t, i) => (
                <li className={t.denied ? 'row tool denied' : 'row tool'} key={`t${i}`}>
                  {t.denied && <span className="tag bad">DENIED</span>}
                  <span className="num">{t.tool}</span>
                  {t.path && <span className="num path">{t.path}</span>}
                  {t.denied && t.reason && <span className="reason">{t.reason}</span>}
                </li>
              ))}
            </ul>
          )}
          {diffs.length > 0 ? (
            <DiffView diffs={diffs} result={result} />
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
