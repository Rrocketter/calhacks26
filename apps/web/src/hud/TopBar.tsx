import type { HudState } from './state';

type Props = {
  hud: HudState;
  mode: 'live' | 'mock';
  running: boolean;
  starting: boolean;
  onStart(): void;
  onStop(): void;
  onDemo(): void;
};

function Counter({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="counter">
      <span className="label">{label}</span>
      <span className="value num">
        {value}
        {unit && value !== '-' && <span className="unit">{unit}</span>}
      </span>
    </div>
  );
}

export function TopBar({ hud, mode, running, starting, onStart, onStop, onDemo }: Props) {
  const { count, totalMs } = hud.moss;
  const avg = count ? (totalMs / count).toFixed(1) : '-';
  const ttfa = hud.ttfa.client ?? hud.ttfa.server;
  return (
    <header className="topbar">
      <span className="wordmark">AHEAD</span>
      {mode === 'mock' ? (
        <span className="badge on">MOCK</span>
      ) : (
        <span className={running ? 'badge on' : 'badge'}>LIVE</span>
      )}
      <div className="counters">
        <Counter label="Moss queries · this turn" value={String(count)} />
        <Counter label="Avg retrieval" value={avg} unit="ms" />
        <Counter label="Time to first audio" value={ttfa === undefined ? '-' : String(Math.round(ttfa))} unit="ms" />
      </div>
      {hud.confirmWindow && <span className="badge on">Listening for yes / no</span>}
      <span className="spacer" />
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
