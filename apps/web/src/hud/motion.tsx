import { useEffect, useRef, useState } from 'react';
import { micLevel } from '../audio/level';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Eases from the last shown value to `value` so counters visibly tick instead of jumping.
export function Tween({ value, digits = 0, ms = 450 }: { value: number; digits?: number; ms?: number }) {
  const [shown, setShown] = useState(value);
  const at = useRef(value);
  useEffect(() => {
    const from = at.current;
    if (from === value || reduced()) {
      at.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const v = from + (value - from) * (1 - (1 - k) ** 3);
      at.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{shown.toFixed(digits)}</>;
}

// Appends `last` each time `count` moves; a drop in count (new turn) starts over.
export function useSeries(count: number, last: number | null, max = 32): number[] {
  const [s, setS] = useState({ count: 0, values: [] as number[] });
  if (s.count !== count) {
    const base = count < s.count ? [] : s.values;
    setS({ count, values: count === 0 || last === null ? [] : [...base, last].slice(-max) });
  }
  return s.values;
}

export function Sparkline({ values, w = 112, h = 30 }: { values: number[]; w?: number; h?: number }) {
  const top = Math.max(4, ...values) * 1.15;
  // Points spread over the width until there are enough to fill it at a fixed pitch.
  const step = w / Math.max(values.length - 1, 12);
  const pts = values.map((v, i) => [i * step, h - 2 - (v / top) * (h - 6)] as const);
  const last = pts.at(-1);
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <line className="spark-base" x1={0} x2={w} y1={h - 2} y2={h - 2} />
      {pts.length > 1 && <polyline points={pts.map((p) => p.join(',')).join(' ')} />}
      {last && <circle key={values.length} cx={last[0]} cy={last[1]} r={3} />}
    </svg>
  );
}

// Mic level as a thin bar growing from the middle of the top bar's bottom rule,
// driven straight from the capture RMS without React renders.
export function LevelMeter() {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const target = Math.min(1, Math.sqrt(micLevel.get()) * 2.2);
      shown = target > shown ? target : shown * 0.9 + target * 0.1;
      bar.current?.style.setProperty('--level', shown.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span className="meter" aria-hidden>
      <span className="meter-fill" ref={bar} />
    </span>
  );
}

// Idle waveform: a rolling history of the mic level as soft rounded bars, written straight
// to the DOM per frame. With no mic (mock, or not started) it breathes at a low level.
export function Waveform({ bars = 48 }: { bars?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = [...(box.current?.children ?? [])] as HTMLElement[];
    const hist = new Array<number>(els.length).fill(0.12);
    const still = reduced();
    let raf = 0;
    let last = 0;
    let shown = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 70) return;
      last = now;
      const mic = micLevel.get();
      const t = now / 1000;
      if (mic <= 0.002) {
        // No mic signal: a slow travelling swell across the bars instead of a flat line.
        els.forEach((el, i) => {
          const h = still ? 0.16 : 0.2 + 0.16 * Math.sin(t * 2.1 - i * 0.32) * Math.sin(t * 0.7 + i * 0.09);
          hist[i] = h;
          el.style.setProperty('--h', h.toFixed(3));
        });
        return;
      }
      const target = Math.min(1, Math.sqrt(mic) * 2.4);
      shown = target > shown ? target : shown * 0.7 + target * 0.3;
      hist.shift();
      // A little per-bar jitter so a steady level still reads as sound, not a block.
      hist.push(Math.max(0.06, shown * (still ? 1 : 0.6 + 0.8 * Math.random())));
      els.forEach((el, i) => el.style.setProperty('--h', hist[i]!.toFixed(3)));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="wave" ref={box} aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}
