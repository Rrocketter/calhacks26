import { pendingConfirm, type HudState } from './state';
import { LevelMeter, Tween } from './motion';

type Props = {
  hud: HudState;
  mode: 'live' | 'mock';
  running: boolean;
  starting: boolean;
  onStart(): void;
  onStop(): void;
  onDemo(): void;
};

type CounterProps = { label: string; short: string; value: number | null; digits?: number; unit?: string };

// `short` replaces the label on narrow screens so the bar never overflows.
function Counter({ label, short, value, digits = 0, unit }: CounterProps) {
  return (
    <div className="counter">
      <span className="label" title={label}>
        <span className="long">{label}</span>
        <span className="short">{short}</span>
      </span>
      <span className="value num">
        {value === null ? '-' : <Tween value={value} digits={digits} />}
        {unit && value !== null && <span className="unit">{unit}</span>}
      </span>
    </div>
  );
}

export function TopBar({ hud, mode, running, starting, onStart, onStop, onDemo }: Props) {
  const { count, totalMs } = hud.moss;
  const avg = count ? totalMs / count : null;
  const ttfa = hud.ttfa.client ?? hud.ttfa.server;
  const awaiting = pendingConfirm(hud, mode, running) !== null;
  return (
    <header className="topbar">
      <span className="wordmark">
        AHEAD<span className="chevron" aria-hidden />
      </span>
      {mode === 'mock' ? (
        <span className="badge on">MOCK</span>
      ) : (
        <span className={running ? 'badge on' : 'badge'}>LIVE</span>
      )}
      {awaiting ? (
        <span className="state-pill yesno" role="status" key="yesno">
          <span className="state-dot" />
          Listening for yes / no
        </span>
      ) : (
        <span className="state-pill num" key={hud.state}>
          <span className="state-dot" />
          {hud.state.replace(/_/g, ' ')}
        </span>
      )}
      <div className="counters">
        <Counter label="Moss queries · turn" short="Queries" value={count} />
        <Counter label="Avg retrieval" short="Avg" value={avg} digits={1} unit="ms" />
        <Counter label="Time to first audio" short="TTFA" value={ttfa === undefined ? null : Math.round(ttfa)} unit="ms" />
      </div>
      <span className="spacer" />
      {mode === 'live' && running && <LevelMeter />}
      <div className="controls">
        {mode === 'live' && (
          <button className="btn" disabled={starting} onClick={running ? onStop : onStart}>
            {running ? 'Stop' : starting ? 'Starting' : 'Start'}
          </button>
        )}
        <button className="btn primary" disabled={mode === 'live' && !running} onClick={onDemo}>
          Demo
        </button>
      </div>
    </header>
  );
}
