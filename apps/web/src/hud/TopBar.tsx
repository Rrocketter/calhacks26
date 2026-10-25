import { CLOUD_SIM_MS, RETRIEVAL_MODES, type RetrievalMode } from '@ahead/contracts';
import { pendingConfirm, type HudState } from './state';
import { LevelMeter, Tween } from './motion';
import { stateLabel, type View } from './Stepper';

type Props = {
  hud: HudState;
  mode: 'live' | 'mock';
  running: boolean;
  starting: boolean;
  onStart(): void;
  onStop(): void;
  onDemo(): void;
  onRetrieval(mode: RetrievalMode): void;
  view: View;
  onView(view: View): void;
};

type CounterProps = { label: string; short: string; value: number | null; digits?: number; unit?: string };

// `short` replaces the label on narrow screens so the bar never overflows.
function Counter({ label, short, value, digits = 0, unit }: CounterProps) {
  return (
    <div className="stat">
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

const seconds = (ms: number | undefined) => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`);

/** Retrieval A/B: Moss in process vs the same results after a simulated cloud round trip, with interject lag per mode. */
function RetrievalToggle({ hud, enabled, onPick }: { hud: HudState; enabled: boolean; onPick(m: RetrievalMode): void }) {
  return (
    <div className="retrieval" role="group" aria-label="Retrieval A/B">
      <span className="label" title="Interject lag: first partial with the contradicted word to the interject">
        Retrieval · interject lag
      </span>
      <div className="seg">
        {RETRIEVAL_MODES.map((m) => (
          <button
            key={m}
            className={hud.retrieval === m ? 'seg-btn on' : 'seg-btn'}
            aria-pressed={hud.retrieval === m}
            disabled={!enabled}
            onClick={() => onPick(m)}
          >
            {m === 'moss' ? 'Moss' : `Cloud-sim +${CLOUD_SIM_MS}`}
            <span className="lag num">{seconds(hud.interjectLag[m])}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Product (plain words, the result as the real thing) or Engineering (every internal). D toggles. */
function ViewSwitch({ view, onView }: { view: View; onView(v: View): void }) {
  return (
    <div className="view-switch" role="group" aria-label="View">
      <div className="seg" title="Switch view (D)" aria-keyshortcuts="D">
        {(['product', 'engineering'] as const).map((v) => (
          <button key={v} className={view === v ? 'seg-btn on' : 'seg-btn'} aria-pressed={view === v} onClick={() => onView(v)}>
            {v === 'product' ? 'Product' : 'Engineering'}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TopBar({ hud, mode, running, starting, onStart, onStop, onDemo, onRetrieval, view, onView }: Props) {
  const { count, totalMs } = hud.moss;
  const avg = count ? totalMs / count : null;
  const ttfa = hud.ttfa.client ?? hud.ttfa.server;
  const awaiting = pendingConfirm(hud, mode, running) !== null;
  return (
    <header className="topbar">
      <span className="brand">
        <span className="wordmark" aria-label="ahem">
          ah<span className="e">e</span>m
        </span>
        <span className="tagline">Speculative execution for conversation</span>
      </span>
      {mode === 'mock' ? (
        <span className="badge on">Mock</span>
      ) : (
        <span className={running ? 'badge on' : 'badge'}>Live</span>
      )}
      {awaiting ? (
        <span className="state-pill yesno" role="status" key="yesno">
          <span className="state-dot" />
          Listening for yes / no
        </span>
      ) : (
        <span className={view === 'engineering' ? 'state-pill num' : 'state-pill'} key={`${hud.state}:${view}`}>
          <span className="state-dot" />
          {stateLabel(hud.state, view)}
        </span>
      )}
      <div className="stats">
        <Counter label="Moss queries · turn" short="Queries" value={count} />
        <Counter label="Avg retrieval" short="Avg" value={avg} digits={1} unit="ms" />
        <Counter label="Time to first audio" short="TTFA" value={ttfa === undefined ? null : Math.round(ttfa)} unit="ms" />
      </div>
      <RetrievalToggle hud={hud} enabled={mode === 'live' && running} onPick={onRetrieval} />
      <span className="spacer" />
      <ViewSwitch view={view} onView={onView} />
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
