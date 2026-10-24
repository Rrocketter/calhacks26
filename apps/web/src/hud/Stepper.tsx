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

export function Stepper({ hud, view }: { hud: HudState; view: View }) {
  const current = SLOTS.findIndex((slot) => slot.includes(hud.state));
  return (
    <ol className="stepper">
      {SLOTS.map((slot, i) => {
        // The outcome slot shows whichever outcome happened, else both, dim.
        const hit = slot.filter((s) => hud.reached.includes(s));
        const shown = hit.length ? hit.slice(-1) : slot;
        const reached = hit.length > 0;
        const bad = shown[0] === 'ROLLED_BACK' && reached;
        const good = shown[0] === 'COMMITTED' && reached;
        const cls = [
          'step',
          reached && 'reached',
          i === current && 'current',
          bad && 'bad',
          good && 'good',
          i <= current && 'linked',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <li className={cls} key={slot.join('|')}>
            <span className="dot" />
            <span className="step-label">
              {shown.map((s) => (
                <span key={s}>{stateLabel(s, view)}</span>
              ))}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
