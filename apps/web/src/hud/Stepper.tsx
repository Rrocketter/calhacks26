import type { State } from '@ahead/contracts';
import type { HudState } from './state';

const SLOTS: State[][] = [['LISTENING'], ['BELIEF_FORMING'], ['SPECULATING'], ['STAGED'], ['COMMITTED', 'ROLLED_BACK']];

const label = (s: State) => s.replace(/_/g, ' ');

export function Stepper({ hud }: { hud: HudState }) {
  const current = SLOTS.findIndex((slot) => slot.includes(hud.state));
  return (
    <ol className="stepper">
      {SLOTS.map((slot, i) => {
        // The outcome slot shows whichever outcome happened, else both, dim.
        const hit = slot.filter((s) => hud.reached.includes(s));
        const shown = hit.length ? hit.slice(-1) : slot;
        const reached = hit.length > 0;
        const bad = shown[0] === 'ROLLED_BACK' && reached;
        const cls = ['step', reached && 'reached', i === current && 'current', bad && 'bad', i <= current && 'linked']
          .filter(Boolean)
          .join(' ');
        return (
          <li className={cls} key={slot.join('|')}>
            <span className="dot" />
            <span className="step-label">
              {shown.map((s) => (
                <span key={s}>{label(s)}</span>
              ))}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
