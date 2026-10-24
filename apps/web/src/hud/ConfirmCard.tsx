import { useEffect, useRef } from 'react';
import type { ConfirmTarget, HudState } from './state';

type Props = { hud: HudState; target: ConfirmTarget; onAnswer(apply: boolean): void };

const APPLY_KEYS = new Set(['y', 'Y', 'Enter']);
const DISCARD_KEYS = new Set(['n', 'N', 'Escape']);

export function typing(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

// Mounted only while a confirm is pending. Voice, click and keys all go through onAnswer; the
// caller keeps the first answer per target, and the server ignores a losing one.
export function ConfirmCard({ hud, target, onAnswer }: Props) {
  const answer = useRef(onAnswer);
  answer.current = onAnswer;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const apply = APPLY_KEYS.has(e.key) ? true : DISCARD_KEYS.has(e.key) ? false : null;
      if (apply === null) return;
      e.preventDefault(); // Enter must not also click a focused button
      answer.current(apply);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const correction = target.kind === 'correction';
  const title = correction ? (hud.interject?.text ?? 'Apply the correction?') : 'Apply this change?';
  const files = correction ? [] : hud.diffs.map((d) => d.file);
  return (
    <div className="confirm-card" role="alertdialog" aria-label={title}>
      <span className="label">{correction ? 'Correction' : 'Staged'} · listening for yes / no</span>
      <span className="confirm-title">{title}</span>
      {files.length > 0 && <span className="confirm-files num">{files.join(' · ')}</span>}
      <div className="confirm-actions">
        <button className="btn primary" onClick={() => onAnswer(true)}>
          Apply <kbd>Y</kbd> <kbd>Enter</kbd>
        </button>
        <button className="btn" onClick={() => onAnswer(false)}>
          Discard <kbd>N</kbd> <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}
