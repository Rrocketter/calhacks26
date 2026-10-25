import type { State } from '@ahead/contracts';
import type { HudState } from './state';

const SLOTS: State[][] = [['LISTENING'], ['BELIEF_FORMING'], ['SPECULATING'], ['STAGED'], ['COMMITTED', 'ROLLED_BACK']];

export type View = 'product' | 'engineering';

// Product mode names each state in plain words.
export const PLAIN_STATE: Record<State, string> = {
  LISTENING: 'Listening',
  BELIEF_FORMING: 'Understanding',
  SPECULATING: 'Preparing',
  STAGED: 'Ready',
  COMMITTED: 'Applied',
  ROLLED_BACK: 'Discarded',
};

export const stateLabel = (s: State, view: View) => (view === 'product' ? PLAIN_STATE[s] : s.replace(/_/g, ' '));

/** The one terminal step: "Applied" until the turn ends, then whichever outcome was reached last. */
export const terminalLabel = (reached: State[], view: View) =>
  stateLabel(reached.filter((s) => s === 'COMMITTED' || s === 'ROLLED_BACK').at(-1) ?? 'COMMITTED', view);

export function Stepper({ hud, view }: { hud: HudState; view: View }) {
  const current = SLOTS.findIndex((slot) => slot.includes(hud.state));
  return (
    <ol className="stepper">
      {SLOTS.map((slot, i) => {
        const hit = slot.filter((s) => hud.reached.includes(s));
        const reached = hit.length > 0;
        const terminal = slot.length > 1;
        const outcome = reached ? hit.at(-1) : null;
        const cls = [
          'step',
          reached && i < current && 'done',
          i === current && 'current',
          outcome === 'ROLLED_BACK' && 'bad',
          outcome === 'COMMITTED' && 'good',
          i <= current && 'linked',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <li className={cls} key={slot.join('|')}>
            <span className="dot" />
            {/* Keyed by text so the terminal label swaps in when the outcome lands */}
            <span className="step-label" key={terminal ? terminalLabel(hud.reached, view) : view}>
              {terminal ? terminalLabel(hud.reached, view) : stateLabel(slot[0]!, view)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
