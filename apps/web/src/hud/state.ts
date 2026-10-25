import {
  MEMORY_DOC_PREFIX,
  RETRIEVAL_MODES,
  type Belief,
  type ReplyKind,
  type MossHit,
  type RetrievalMode,
  type ServerEvent,
  type State,
} from '@ahead/contracts';

export type ToolCall = { tool: string; path?: string; denied: boolean; reason?: string };
export type DroidResult = { ok: boolean; summary: string; failed: boolean };
export type FinalLine = { turnId: string; text: string; highlight: number | null };
export type Interject = {
  turnId: string;
  text: string;
  said: string | null;
  wordIndex: number | null;
};
export type Reply = { seq: number; turnId: string; text: string; kind: ReplyKind }; // seq: stable caption key
export type HudState = {
  turnId: string | null; // current turn: promoted from turn_start once it speaks
  // Ink can send a bare turn_start right after a timeout turn_end, so a new turn only takes
  // over on its first non-empty transcript; until then the finished turn's late events still land.
  pendingTurnId: string | null;
  partial: string;
  eagerEnd: boolean; // turn_eager_end seen, cleared by turn_resume / promotion
  finals: FinalLine[]; // last 3
  interject: Interject | null; // cleared at promotion; the highlight survives in finals
  belief: Belief | null;
  moss: { count: number; totalMs: number; lastMs: number | null }; // reset at promotion
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
  confirm: ConfirmTarget | null; // the server is listening for a yes / no (confirm_window metric)
  retrieval: RetrievalMode; // confirmed by the server's retrieval:<mode> metric; kept across resets
  interjectLag: Partial<Record<RetrievalMode, number>>; // last interject_lag:<mode> metric per mode; kept across resets
  replies: Reply[]; // what Ahem said, as captions; last REPLIES_MAX
  error: string | null;
};
const REPLIES_MAX = 6;

export type ConfirmTarget = { kind: 'correction' | 'apply'; turnId: string };
export type HudAction = ServerEvent | { type: 'client_ttfa'; ms: number } | { type: 'reset' };

export function initialHud(): HudState {
  return {
    turnId: null,
    pendingTurnId: null,
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
    confirm: null,
    retrieval: 'moss',
    interjectLag: {},
    replies: [],
    error: null,
  };
}

export function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// A trailing possessive is dropped: the claim says "Tuesday", Ink writes "Tuesday's" (or "Tuesday's,").
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9'’]/g, '').replace(/['’]s$/, '').replace(/['’]/g, '');

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

// The claim the interject text names; the tracker may fire on any claim, not just the first.
function interjectSaid(belief: Belief | null, text: string): string | null {
  const claims = belief?.claims ?? [];
  const hay = ` ${words(text).map(norm).join(' ')} `;
  // The interject names the known value ("Say Friday?"); older wordings named the said one.
  const named = (v: string) => {
    const w = words(v).map(norm).filter(Boolean).join(' ');
    return w !== '' && hay.includes(` ${w} `);
  };
  const hit = claims.find((c) => named(c.known) || named(c.said));
  return (hit ?? claims[0])?.said ?? null;
}

// `confirm_window:<kind>:<turnId>` with ms > 0 opens the window, ms 0 closes it.
function confirmTarget(s: HudState, label: string, ms: number): ConfirmTarget | null {
  if (ms <= 0) return null;
  const [, kind, turnId] = label.split(':');
  if ((kind === 'correction' || kind === 'apply') && turnId) return { kind, turnId };
  return s.stateTurnId ? { kind: 'apply', turnId: s.stateTurnId } : null;
}

/** What a yes / no answers right now. The mock never sends confirm_window: there it is staged work after the turn ended. */
function retrievalMode(v: string): RetrievalMode | null {
  return (RETRIEVAL_MODES as readonly string[]).includes(v) ? (v as RetrievalMode) : null;
}

/** Hits retrieved from conversation memory (Moss `ahead-memory`), tagged "memory" in the Moss panel. */
export function isMemoryHit(h: MossHit): boolean {
  return h.docId.startsWith(MEMORY_DOC_PREFIX);
}

/** The Moss panel's hits: the top 3, plus any memory hits ranked below them. */
export function panelHits(topHits: MossHit[]): MossHit[] {
  return [...topHits.slice(0, 3), ...topHits.slice(3).filter(isMemoryHit)];
}

export function pendingConfirm(s: HudState, mode: 'live' | 'mock', running: boolean): ConfirmTarget | null {
  if (mode === 'live') return running ? s.confirm : null;
  const staged =
    s.state === 'STAGED' &&
    s.stateTurnId !== null &&
    s.droidTurnId === s.stateTurnId &&
    s.finals.some((f) => f.turnId === s.stateTurnId);
  return staged ? { kind: 'apply', turnId: s.stateTurnId! } : null;
}

function promote(s: HudState, turnId: string): HudState {
  return {
    ...s,
    turnId,
    pendingTurnId: null,
    partial: '',
    eagerEnd: false,
    interject: null,
    moss: { count: 0, totalMs: 0, lastMs: null },
    error: null,
  };
}

// A transcript for another turn takes over only with real text, and never for a finished turn.
function claimTurn(s: HudState, turnId: string, text: string): HudState | null {
  if (turnId === s.turnId) return s;
  if (text.trim() === '' || s.finals.some((f) => f.turnId === turnId)) return null;
  return promote(s, turnId);
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
      // The retrieval A/B readout compares runs, so it outlives a demo reset.
      return { ...initialHud(), retrieval: s.retrieval, interjectLag: s.interjectLag };
    case 'client_ttfa':
      return { ...s, ttfa: { ...s.ttfa, client: a.ms } };
    case 'turn_start':
      return s.turnId === null ? promote(s, a.turnId) : { ...s, pendingTurnId: a.turnId };
    case 'transcript_partial': {
      const t = claimTurn(s, a.turnId, a.text);
      if (!t) return s;
      return { ...t, partial: a.text, interject: resolveInterject(t, a.turnId, a.text) };
    }
    case 'transcript_final': {
      const t = claimTurn(s, a.turnId, a.text);
      if (!t) return s;
      const interject = resolveInterject(t, a.turnId, a.text);
      const highlight = interject && interject.turnId === a.turnId ? interject.wordIndex : null;
      const finals = [...t.finals, { turnId: a.turnId, text: a.text, highlight }].slice(-3);
      return { ...t, partial: '', finals, interject };
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
      const said = interjectSaid(s.belief, a.text);
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
      if (a.label.startsWith('confirm_window')) return { ...s, confirm: confirmTarget(s, a.label, a.ms) };
      if (a.label.startsWith('retrieval:')) {
        const m = retrievalMode(a.label.slice('retrieval:'.length));
        return m ? { ...s, retrieval: m } : s;
      }
      if (a.label.startsWith('interject_lag:')) {
        const m = retrievalMode(a.label.slice('interject_lag:'.length));
        return m ? { ...s, interjectLag: { ...s.interjectLag, [m]: a.ms } } : s;
      }
      return a.source === 'sonic' && a.label === 'ttfa'
        ? { ...s, ttfa: { ...s.ttfa, server: a.ms } }
        : s;
    case 'error':
      return { ...s, error: `${a.source ?? 'server'}: ${a.message}` };
    case 'assistant_reply':
      return {
        ...s,
        replies: [...s.replies, { seq: (s.replies.at(-1)?.seq ?? 0) + 1, turnId: a.turnId, text: a.text, kind: a.kind }].slice(-REPLIES_MAX),
      };
    case 'tts_audio_chunk':
      return s;
  }
}
