import type { HudState } from './state';
import { Stepper, type View } from './Stepper';
import { ResultCard } from './ResultCard';
import { buildCard, intentLabel } from './cards';
import { DiffView } from './DiffView';
import { feedRows, type FeedRow } from './feed';
import { SparkIcon } from './icons';

// canSend: a transport is up (live socket open, or mock).
type Props = { hud: HudState; view: View; canSend: boolean; onConfirm(apply: boolean): void };

// Rows beyond this would squeeze the diff and push Apply / Discard out of the panel.
const FEED_MAX = 6;

// Stable per-row keys so only new rows animate in (and a denied row flashes exactly once).
function rowKeys(rows: FeedRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = r.kind === 'tool' ? `tool:${r.tool}:${r.path ?? ''}:${r.denied}` : `${r.kind}:${r.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

export function ExecutorPanel({ hud, view, canSend, onConfirm }: Props) {
  const { plan, steps, tools, diffs, result } = hud;
  const { rows, hidden } = feedRows(hud, FEED_MAX);
  const keys = rowKeys(rows);
  const idle = hud.droidTurnId === null && plan.length + steps.length + tools.length + diffs.length === 0 && !result;
  // The server rolls back a live spec on the next turn but only says LISTENING for the new one.
  const prior = hud.droidTurnId !== null && hud.droidTurnId !== hud.stateTurnId;
  const rolledBack = !prior && hud.state === 'ROLLED_BACK';
  const canConfirm = canSend && !prior && (hud.state === 'SPECULATING' || hud.state === 'STAGED');
  const stale = result?.failed === true;
  // Only a live, unfinished run has tool calls still in flight; an aborted one's pending calls never resolve.
  const running = !prior && !result && (hud.state === 'SPECULATING' || hud.state === 'STAGED');
  const ended = hud.state === 'COMMITTED' || hud.state === 'ROLLED_BACK';
  const mark =
    stale && result ? { tag: 'STALE', note: result.summary } : rolledBack ? { tag: 'ROLLED BACK' } : null;
  const product = view === 'product';
  const card = buildCard(hud);
  // A lookup turn never runs Droid, so droidTurnId still names the last Droid turn; its answer is current.
  const dimmed = prior && card?.kind !== 'answer';
  // A lookup answer is not something to apply, so it never carries an outcome stamp.
  const stamp =
    !card || card.kind === 'answer' || prior
      ? null
      : hud.state === 'COMMITTED'
        ? { text: 'Applied', tone: 'good' as const }
        : stale
          ? { text: 'Staged, not finished', tone: 'err' as const }
          : rolledBack
            ? { text: 'Discarded', tone: 'bad' as const }
            : null;
  return (
    <section className={dimmed ? 'panel executor prior' : 'panel executor'}>
      <div className="panel-head">
        <span className="label">
          <span className="idx">03</span>
          {product ? 'Result' : 'Executor'}
        </span>
        {dimmed && <span className="tag dim">Previous turn</span>}
        {/* Same name the server's executor/git.ts gives the branch */}
        {hud.droidTurnId && <span className={['ms num branch eng-only', (ended || prior) && 'gone'].filter(Boolean).join(' ')}>spec/{hud.droidTurnId.replace(/[^A-Za-z0-9._-]/g, '-')}</span>}
      </div>
      <Stepper hud={hud} view={view} />
      <div className="exec-views">
        <div className="exec-view product" inert={!product}>
          {card ? (
            <ResultCard card={card} stamp={stamp} />
          ) : idle ? (
            <div className="rc placeholder">
              <div className="rc-head">
                <SparkIcon />
                Waiting for a request
              </div>
              <div className="rc-body">
                <span className="skel" />
                <span className="skel short" />
                <span className="placeholder-note">A draft appears here before you finish talking.</span>
              </div>
            </div>
          ) : diffs.length > 0 ? (
            <DiffView diffs={diffs} mark={mark} />
          ) : running ? (
            <div className="rc-pending">
              <span className="rc-pending-label">Preparing</span>
              {intentLabel(hud.belief)}
            </div>
          ) : (
            <span className="empty">{rolledBack ? 'Dropped. Nothing changed.' : stale ? 'Could not finish.' : 'Nothing to show.'}</span>
          )}
        </div>
        <div className="exec-view engineering" inert={product}>
          {idle ? (
            <span className="empty">No speculation yet</span>
          ) : (
            <>
              {rows.length > 0 && (
                <ul className="feed">
                  {hidden > 0 && <li className="row more num">+{hidden} earlier</li>}
                  {rows.map((r, i) => {
                    const n = <span className="lno">{pad(hidden + i + 1)}</span>;
                    return r.kind === 'tool' ? (
                      <li
                        className={['row tool', r.denied && 'denied', r.status === 'ok' && 'done', r.status === 'error' && 'err']
                          .filter(Boolean)
                          .join(' ')}
                        key={keys[i]}
                      >
                        {n}
                        {r.denied ? (
                          <span className="tag bad">DENIED</span>
                        ) : (
                          <span className={r.status === 'pending' && running ? 'check spin' : 'check'}>
                            {r.status === 'ok' ? '✓' : r.status === 'error' ? '✕' : running ? '' : '○'}
                          </span>
                        )}
                        <span className="tool-name">{r.tool}</span>
                        {r.path && <span className="path">{r.path}</span>}
                        {r.denied && r.reason && <span className="reason">{r.reason}</span>}
                      </li>
                    ) : (
                      <li className={r.kind === 'step' || r.done ? 'row done' : 'row'} key={keys[i]}>
                        {n}
                        <span className="check">{r.kind === 'step' || r.done ? '✓' : '›'}</span>
                        <span className="text">{r.text}</span>
                      </li>
                    );
                  })}
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
        </div>
      </div>
      <div className={canConfirm && hud.state === 'STAGED' ? 'confirm ready' : 'confirm'}>
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
