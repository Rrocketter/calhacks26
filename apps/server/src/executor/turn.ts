// One Droid turn: SDK stream events -> droid_event wire events, watchdog, write permission handler.
// Ported from scripts/spike-droid.ts (makeHandler, runTurn). Never logs model text, tool result
// bodies or env values; lengths and booleans only.
import { DroidMessageType, ToolConfirmationOutcome, type createSession, type DroidStreamEvent } from '@factory/droid-sdk/node';
import type { DroidToolPayload } from '@ahead/contracts';
import { logLatency } from '../log.js';
import { inputPaths, patchPaths, type Guard } from './guard.js';
import type { DroidLike, Emit } from './types.js';

type PermissionParams = Parameters<NonNullable<NonNullable<Parameters<typeof createSession>[0]>['permissionHandler']>>[0];
// ProceedEdit is excluded so the handler is assignable to the SDK's permissionHandler type.
export type PermissionHandler = (params: PermissionParams) => Exclude<ToolConfirmationOutcome, ToolConfirmationOutcome.ProceedEdit>;

export type TurnOutcome = 'success' | 'interrupted' | 'aborted' | 'error';
export interface TurnOptions {
  turnId: string;
  guard: Guard;
  emit: Emit;
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 1500;
const SUMMARY_CAP = 500;

function emitTool(emit: Emit, turnId: string, payload: DroidToolPayload, denied: boolean): void {
  emit({ type: 'droid_event', turnId, kind: 'tool', payload, ...(denied ? { denied: true } : {}), ts: Date.now() });
}

function emitDenied(emit: Emit, turnId: string, tool: string, p: string | null | undefined, reason: string): void {
  emitTool(emit, turnId, { tool, ...(p ? { path: p } : {}), denied: true, reason }, true);
}

// Gates writes only. ProceedOnce when every path of every create/edit/apply_patch is inside the
// workspace; anything else (unknown type, no path, sandbox violation, handler error) is Cancel.
export function makePermissionHandler(guard: Guard, turnIdRef: () => string, emit: Emit): PermissionHandler {
  return (params) => {
    try {
      const offered = new Set(params.options.map((o) => o.value));
      if (params.toolUses.length === 0) return ToolConfirmationOutcome.Cancel;
      let all = true;
      for (const tu of params.toolUses) {
        const d = (tu.details ?? {}) as {
          type?: string;
          violationType?: string;
          filePath?: string;
          patchContent?: string;
          files?: { filePath: string; moveTo?: string }[];
        };
        const type = String(d.type ?? tu.confirmationType);
        const name = tu.toolUse.name;
        if (type === 'sandbox_violation' || String(tu.confirmationType) === 'sandbox_violation') {
          all = false;
          const reason = `sandbox-${d.violationType ?? 'unknown'}`;
          emitDenied(emit, turnIdRef(), name, null, reason);
          console.log(`[droid] permission ${name} type=${type} -> deny reason=${reason}`);
          continue;
        }
        const gated = type === 'edit' || type === 'create' || type === 'apply_patch';
        const paths: string[] = [];
        if (gated) {
          if (d.filePath) paths.push(d.filePath);
          for (const f of d.files ?? []) {
            paths.push(f.filePath);
            if (f.moveTo) paths.push(f.moveTo);
          }
          const inp = (tu.toolUse.input ?? {}) as Record<string, unknown>;
          paths.push(...patchPaths(d.patchContent), ...patchPaths(inp.patch), ...patchPaths(inp.input));
        }
        paths.push(...inputPaths(tu.toolUse.input).paths);
        const unique = [...new Set(paths)];
        const outside = unique.find((p) => !guard.inside(p));
        let reason: string | null = null;
        if (!gated) reason = 'tool-not-allowed';
        else if (unique.length === 0) reason = 'no-path';
        else if (outside !== undefined) reason = 'outside-workspace';
        if (reason !== null) {
          all = false;
          emitDenied(emit, turnIdRef(), name, outside ?? unique[0], reason);
        }
        console.log(`[droid] permission ${name} type=${type} ${unique.join(',') || '-'} -> ${reason === null ? 'allow' : 'deny'}`);
      }
      if (all && offered.has(ToolConfirmationOutcome.ProceedOnce)) return ToolConfirmationOutcome.ProceedOnce;
      return ToolConfirmationOutcome.Cancel;
    } catch (e) {
      console.log(`[droid] permission handler threw (${e instanceof Error ? e.name : 'unknown'}) -> deny`);
      return ToolConfirmationOutcome.Cancel;
    }
  };
}

function outcomeFor(subtype: string): TurnOutcome {
  return subtype === 'success' ? 'success' : subtype === 'interrupted' ? 'interrupted' : 'error';
}

export async function runTurn(
  session: DroidLike,
  prompt: string,
  opts: TurnOptions,
): Promise<{ outcome: TurnOutcome; summary: string; ms: number }> {
  const { turnId, guard, emit } = opts;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const t0 = performance.now();
  const since = (): string => `+${Math.round(performance.now() - t0)}ms`;
  const send = (kind: 'plan' | 'step' | 'tool', payload: unknown): void =>
    emit({ type: 'droid_event', turnId, kind, payload, ts: Date.now() });

  const calls = new Map<string, string>();
  let text = '';
  let outcome: TurnOutcome = 'error';
  let aborted = false;
  let graceUntil = 0;
  let it: AsyncIterator<DroidStreamEvent> | undefined;
  try {
    it = session.stream(prompt, { includePartialMessages: true })[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<DroidStreamEvent, void> | 'timeout';
      if (aborted) {
        let timer: NodeJS.Timeout | undefined;
        const left = Math.max(0, graceUntil - performance.now());
        next = await Promise.race([
          it.next(),
          new Promise<'timeout'>((r) => {
            timer = setTimeout(() => r('timeout'), left);
          }),
        ]).finally(() => clearTimeout(timer));
      } else {
        next = await it.next();
      }
      if (next === 'timeout') {
        console.log(`[droid] watchdog: turn did not end ${graceMs}ms after interrupt, closing ${since()}`);
        break;
      }
      if (next.done) {
        break;
      }
      const ev = next.value;
      if (ev.type === DroidMessageType.AssistantTextDelta) {
        text += ev.text;
      } else if (ev.type === DroidMessageType.ToolCall) {
        calls.set(ev.toolUseId, ev.name);
        const input = (ev.input ?? {}) as Record<string, unknown>;
        let denial = guard.checkToolCall(ev.name, input);
        if (denial === null && ev.name === 'ApplyPatch' && typeof ev.input === 'string') {
          const named = patchPaths(ev.input);
          const bad = named.find((p) => !guard.inside(p));
          if (named.length === 0 || bad !== undefined) denial = { reason: 'outside-workspace', path: bad ?? null };
        }
        if (denial === null && ev.name === 'ApplyPatch') {
          const bad = [...patchPaths(input.patch), ...patchPaths(input.input)].find((p) => !guard.inside(p));
          if (bad !== undefined) denial = { reason: 'outside-workspace', path: bad };
        }
        const p = inputPaths(input).paths[0];
        console.log(`[droid] tool:${ev.name} ${denial?.path ?? p ?? '-'} ${since()}`);
        if (denial !== null) {
          console.log(`[droid] watchdog abort tool:${ev.name} ${denial.path ?? '-'} reason=${denial.reason} ${since()}`);
          emitDenied(emit, turnId, ev.name, denial.path, denial.reason);
          if (!aborted) {
            aborted = true;
            graceUntil = performance.now() + graceMs;
            try {
              await session.interrupt();
            } catch (e) {
              console.log(`[droid] watchdog interrupt failed (${e instanceof Error ? e.name : 'unknown'})`);
              graceUntil = 0;
            }
          }
        } else if (ev.name === 'TodoWrite') {
          const todos = Array.isArray(input.todos) ? (input.todos as { content?: unknown }[]) : [];
          send('plan', { steps: todos.map((t) => String(t?.content ?? '')) });
        } else {
          send('tool', { tool: ev.name, ...(p ? { path: p } : {}) });
        }
      } else if (ev.type === DroidMessageType.ToolResult) {
        const name = ev.toolName || calls.get(ev.toolUseId) || 'tool';
        console.log(`[droid] result ${name} ${ev.isError ? 'error' : 'ok'} ${since()}`);
        send('step', { text: `${name} ${ev.isError ? 'error' : 'ok'}` });
      } else if (ev.type === DroidMessageType.Error) {
        console.log(`[droid] error ${ev.errorType ?? ''} msgLen=${ev.message.length}`);
      } else if (ev.type === DroidMessageType.Result) {
        if (!aborted) outcome = outcomeFor(ev.subtype);
        console.log(`[droid] done ${ev.subtype} ${since()}`);
        // Release the SDK stream bridge (no next() is pending here). A bare break leaves the
        // generator suspended, and the next stream() on this session throws ConcurrentStreamError.
        if (!aborted) await it.return?.(undefined);
        break;
      }
    }
    if (aborted) outcome = 'aborted';
  } catch (e) {
    outcome = aborted ? 'aborted' : 'error';
    console.log(`[droid] stream failed (${e instanceof Error ? e.name : 'unknown'})`);
  }
  if (aborted) {
    // Not awaited: on a generator parked at a pending next(), return() only settles once that next() does.
    // close() releases the bridge and settles the parked next(); awaiting return() first would deadlock
    // the grace-timeout path.
    void it?.return?.(undefined)?.catch(() => undefined);
    await session.close().catch(() => undefined);
    console.log(`[droid] watchdog: session closed ${since()}`);
  }
  const ms = performance.now() - t0;
  logLatency('droid', 'turn', ms);
  return { outcome, summary: text.trim().slice(0, SUMMARY_CAP), ms };
}
