import type { Belief, ServerEvent, State } from '@ahead/contracts';

export type ToolCall = { tool: string; path?: string; denied: boolean; reason?: string };
export type DroidResult = { ok: boolean; summary: string; failed: boolean };
export type FinalLine = { turnId: string; text: string; highlight: number | null };
export type Interject = {
  turnId: string;
  text: string;
  said: string | null;
  wordIndex: number | null;
};
export type HudState = {
  turnId: string | null; // current turn (turn_start)
  partial: string;
  eagerEnd: boolean; // turn_eager_end seen, cleared by turn_resume / turn_start
  finals: FinalLine[]; // last 3
  interject: Interject | null; // cleared at next turn_start; the highlight survives in finals
  belief: Belief | null;
  moss: { count: number; totalMs: number; lastMs: number | null }; // reset at turn_start
  stateTurnId: string | null;
  state: State;
  reached: State[]; // states seen for stateTurnId, in arrival order, no duplicates
  droidTurnId: string | null;
  plan: string[];
  steps: string[];
  tools: ToolCall[];
  diffs: { file: string; diff: string }[]; // one per file, a repeat replaces in place
  result: DroidResult | null;
  ttfa: { client?: number; server?: number }; // reset at turn_end
  error: string | null;
};
export type HudAction = ServerEvent | { type: 'client_ttfa'; ms: number } | { type: 'reset' };

export function initialHud(): HudState {
  return {
    turnId: null,
    partial: '',
    eagerEnd: false,
    finals: [],
    interject: null,
    belief: null,
    moss: { count: 0, totalMs: 0, lastMs: null },
    stateTurnId: null,
    state: 'LISTENING',
    reached: [],
    droidTurnId: null,
    plan: [],
    steps: [],
    tools: [],
    diffs: [],
    result: null,
    ttfa: {},
    error: null,
  };
}

export function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');

export function findWord(text: string, said: string): number | null {
  const target = norm(said);
  if (!target) return null;
  const i = words(text).findIndex((w) => norm(w) === target);
  return i === -1 ? null : i;
}

// Fill in a missing interject word index from newly arrived text.
function resolveInterject(s: HudState, turnId: string, text: string): Interject | null {
  const i = s.interject;
  if (!i || i.turnId !== turnId || i.wordIndex !== null) return i;
  const wordIndex = i.said === null ? lastIndex(text) : findWord(text, i.said);
  return wordIndex === i.wordIndex ? i : { ...i, wordIndex };
}

function lastIndex(text: string): number | null {
  const n = words(text).length;
  return n ? n - 1 : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function applyDroid(s: HudState, e: Extract<ServerEvent, { type: 'droid_event' }>): HudState {
  const base: HudState =
    e.turnId === s.droidTurnId
      ? s
      : { ...s, droidTurnId: e.turnId, plan: [], steps: [], tools: [], diffs: [], result: null };
  const p: Record<string, unknown> = isRecord(e.payload) ? e.payload : {};
  switch (e.kind) {
    case 'plan':
      return Array.isArray(p.steps) && p.steps.every((x) => typeof x === 'string')
        ? { ...base, plan: p.steps as string[] }
        : base;
    case 'step':
      return typeof p.text === 'string' ? { ...base, steps: [...base.steps, p.text] } : base;
    case 'tool': {
      if (typeof p.tool !== 'string') return base;
      const call: ToolCall = {
        tool: p.tool,
        path: typeof p.path === 'string' ? p.path : undefined,
        reason: typeof p.reason === 'string' ? p.reason : undefined,
        denied: e.denied === true || p.denied === true,
      };
      return { ...base, tools: [...base.tools, call] };
    }
    case 'diff': {
      if (typeof p.file !== 'string' || typeof p.diff !== 'string') return base;
      const entry = { file: p.file, diff: p.diff };
      const at = base.diffs.findIndex((d) => d.file === entry.file);
      const diffs =
        at === -1 ? [...base.diffs, entry] : base.diffs.map((d, i) => (i === at ? entry : d));
      return { ...base, diffs };
    }
    case 'result':
      return {
        ...base,
        result: {
          ok: p.ok === true,
          summary: typeof p.summary === 'string' ? p.summary : '',
          failed: p.failed === true,
        },
      };
  }
}

export function hudReducer(s: HudState, a: HudAction): HudState {
  switch (a.type) {
    case 'reset':
      return initialHud();
    case 'client_ttfa':
      return { ...s, ttfa: { ...s.ttfa, client: a.ms } };
    case 'turn_start':
      return {
        ...s,
        turnId: a.turnId,
        partial: '',
        eagerEnd: false,
        interject: null,
        moss: { count: 0, totalMs: 0, lastMs: null },
      };
    case 'transcript_partial':
      return { ...s, partial: a.text, interject: resolveInterject(s, a.turnId, a.text) };
    case 'transcript_final': {
      const interject = resolveInterject(s, a.turnId, a.text);
      const highlight = interject && interject.turnId === a.turnId ? interject.wordIndex : null;
      const finals = [...s.finals, { turnId: a.turnId, text: a.text, highlight }].slice(-3);
      return { ...s, partial: '', finals, interject };
    }
    case 'turn_eager_end':
      return { ...s, eagerEnd: true };
    case 'turn_resume':
      return { ...s, eagerEnd: false };
    case 'turn_end':
      return { ...s, ttfa: {} };
    case 'belief_update':
      return s.turnId && a.turnId !== s.turnId ? s : { ...s, belief: a.belief };
    case 'moss_hits':
      if (s.turnId && a.turnId !== s.turnId) return s;
      return {
        ...s,
        moss: {
          count: s.moss.count + 1,
          totalMs: s.moss.totalMs + a.latencyMs,
          lastMs: a.latencyMs,
        },
      };
    case 'interject': {
      const said = s.belief?.claims[0]?.said ?? null;
      const wordIndex = said === null ? lastIndex(s.partial) : findWord(s.partial, said);
      return { ...s, interject: { turnId: a.turnId, text: a.text, said, wordIndex } };
    }
    case 'state_change': {
      const fresh = a.turnId !== s.stateTurnId;
      const reached = fresh ? [a.state] : s.reached.includes(a.state) ? s.reached : [...s.reached, a.state];
      return { ...s, stateTurnId: a.turnId, state: a.state, reached };
    }
    case 'droid_event':
      return applyDroid(s, a);
    case 'metric':
      return a.source === 'sonic' && a.label === 'ttfa'
        ? { ...s, ttfa: { ...s.ttfa, server: a.ms } }
        : s;
    case 'error':
      return { ...s, error: `${a.source ?? 'server'}: ${a.message}` };
    case 'tts_audio_chunk':
      return s;
  }
}
