// DroidExecutor: two-phase speculation on a warm Droid session. Phase 1 runs on branch
// spec/<turnId> when a belief locks; Phase 2 gets the final details at Ink's eager end-of-turn,
// commits on the branch and emits the diff. COMMIT merges into main, ROLLBACK deletes the branch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Belief } from '@ahead/contracts';
import { REPO_ROOT, WORKSPACE_DIR } from '../env.js';
import { logLatency } from '../log.js';
import { WorkspaceGit } from './git.js';
import { makeGuard, type Guard } from './guard.js';
import { correctionFixPrompt, mentionedSuperseded, phase1Prompt, phase2Prompt } from './prompts.js';
import { openDroidSession, writeSandboxSettings } from './sandbox.js';
import { makePermissionHandler, runTurn, type PermissionHandler } from './turn.js';
import { redact, SpeculationFailed, type DroidLike, type Emit, type Executor, type Phase2Hooks } from './types.js';

const PHASE_TIMEOUT_MS = 180_000;
// After a phase-timeout interrupt, how long the turn may take to end before the session is closed.
const INTERRUPT_GRACE_MS = 5000;
const OPEN_TIMEOUT_MS = 10_000;

export type OpenSession = (handler: PermissionHandler, signal: AbortSignal) => Promise<DroidLike>;

export interface DroidExecutorOptions {
  // Production must pass WORKSPACE_DIR: openDroidSession uses that global as the Droid cwd.
  workspace: string;
  emit: Emit;
  openSession: OpenSession;
  graceMs?: number;
  now?: () => Date;
  // Per-phase limit on one runTurn (R21); default PHASE_TIMEOUT_MS. Idle warm time does not count.
  phaseTimeoutMs?: number;
  interruptGraceMs?: number;
  openTimeoutMs?: number;
}

interface Live {
  turnId: string;
  post1: string | null;
}

interface Running {
  turnId: string;
  phase: 'phase1' | 'phase2';
}

// Workspace-relative paths of every file under files/, sorted. Missing dir gives [].
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(child);
      else if (d.isFile()) out.push(child);
    }
  };
  walk('files');
  return out.sort();
}

export class DroidExecutor implements Executor {
  private readonly git: WorkspaceGit;
  private readonly guard: Guard;
  private readonly handler: PermissionHandler;
  private session: DroidLike | null = null;
  // Aborted only by closeSession(), never by a timer.
  private sessionAbort: AbortController | null = null;
  private opening: Promise<void> | null = null;
  private live: Live | null = null;
  // Turn of the most recent phase1() call, set at call time (live is only set once that phase1 runs).
  private queuedTurnId: string | null = null;
  private running: Running | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  // Bumped by rollback (supersedes any phase), resetToPhase1 and commit (supersede Phase 2). A phase
  // captures them when queued and resolves quietly if any moved (R15, R25).
  private rollbackGen = 0;
  private resetGen = 0;
  private commitGen = 0;
  // Branch commit holding exactly the last diff shown by the running/last Phase 2 (R25).
  private staged: { turnId: string; sha: string } | null = null;
  // Set by close(); terminal. No session opens and no phase runs afterwards.
  private closed = false;

  constructor(private readonly opts: DroidExecutorOptions) {
    this.git = new WorkspaceGit(opts.workspace);
    this.guard = makeGuard(opts.workspace);
    this.handler = makePermissionHandler(this.guard, () => this.live?.turnId ?? 'none', opts.emit);
  }

  private metric(label: string, ms: number): void {
    this.opts.emit({ type: 'metric', source: 'droid', label, ms });
    logLatency('droid', label, ms);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async closeSession(): Promise<void> {
    const ac = this.sessionAbort;
    this.sessionAbort = null;
    const s = this.session;
    this.session = null;
    if (s) await s.close().catch(() => undefined);
    ac?.abort();
  }

  private async fail(reason: string, cause?: unknown): Promise<never> {
    await this.closeSession();
    console.log(`[droid] speculation failed: ${reason}`);
    throw new SpeculationFailed(reason, cause === undefined ? undefined : { cause });
  }

  // Runs one phase's turn under the per-phase timeout. On expiry it interrupts the turn, which then
  // ends as a non-success outcome and goes through fail(), closing the session. If the turn ignores
  // the interrupt, close() after a grace period releases the SDK bridge and settles the parked next().
  private async timed<T>(s: DroidLike, label: string, run: () => Promise<T>): Promise<T> {
    const ms = this.opts.phaseTimeoutMs ?? PHASE_TIMEOUT_MS;
    const graceMs = this.opts.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      console.log(`[droid] ${label} timeout after ${ms}ms, interrupting`);
      void s.interrupt().catch(() => undefined);
      grace = setTimeout(() => {
        console.log(`[droid] ${label} did not end ${graceMs}ms after interrupt, closing`);
        void s.close().catch(() => undefined);
      }, graceMs);
      grace.unref();
    }, ms);
    timer.unref();
    try {
      return await run();
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
    }
  }

  // Interrupt the running phase if it is one the caller supersedes; errors ignored.
  private async interruptRunning(phases: Running['phase'][]): Promise<void> {
    if (this.running && phases.includes(this.running.phase) && this.session) {
      await this.session.interrupt().catch(() => undefined);
    }
  }

  // On the chain, so a warm() issued right after commit/rollback opens a fresh session after them.
  warm(): Promise<void> {
    return this.enqueue(() => this.ensureSession());
  }

  // Never throws; on failure emits an error event and leaves the session null.
  private async ensureSession(): Promise<void> {
    if (this.closed || this.session) return;
    if (this.opening) return this.opening;
    this.opening = this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    const ac = new AbortController();
    const t0 = performance.now();
    const limit = this.opts.openTimeoutMs ?? OPEN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const opening = this.opts.openSession(this.handler, ac.signal);
    try {
      const s = await Promise.race([
        opening,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`createSession timeout after ${limit}ms`));
          }, limit);
        }),
      ]);
      this.metric('createSession', performance.now() - t0);
      this.session = s;
      this.sessionAbort = ac;
    } catch (e) {
      if (timedOut) {
        ac.abort();
        // A session that still arrives is never adopted.
        opening.then(
          (late) => {
            console.log('[droid] createSession resolved after timeout, closing it');
            return late.close();
          },
          () => undefined,
        ).catch(() => undefined);
      }
      const message = redact(e);
      console.log(`[droid] createSession failed msgLen=${message.length}`);
      this.opts.emit({ type: 'error', source: 'droid', message });
    } finally {
      clearTimeout(timer);
    }
  }

  phase1(turnId: string, belief: Belief): Promise<void> {
    const gen = this.rollbackGen;
    this.queuedTurnId = turnId;
    return this.enqueue(async () => {
      if (this.closed) throw new SpeculationFailed('executor closed');
      if (gen !== this.rollbackGen) return;
      if (this.live) await this.doRollback(this.live.turnId);
      await this.ensureSession();
      const s = this.session;
      if (!s) return this.fail('no droid session');
      const t0 = performance.now();
      this.live = { turnId, post1: null };
      try {
        await this.git.prepare(turnId);
      } catch (e) {
        return this.fail('git prepare failed', e);
      }
      const prompt = phase1Prompt(belief, listFiles(this.opts.workspace));
      // A rollback that arrived during session open or prepare had nothing to interrupt.
      if (gen !== this.rollbackGen) return;
      this.running = { turnId, phase: 'phase1' };
      const r = await this.timed(s, 'phase1', () =>
        runTurn(s, prompt, { turnId, guard: this.guard, emit: this.opts.emit, graceMs: this.opts.graceMs }),
      ).finally(() => {
        this.running = null;
      });
      if (gen !== this.rollbackGen) return;
      if (r.outcome !== 'success') return this.fail(`phase1 ${r.outcome}`);
      try {
        this.live.post1 = await this.git.commitAll('phase1');
      } catch (e) {
        return this.fail('git commit failed', e);
      }
      this.metric('phase1', performance.now() - t0);
    });
  }

  phase2(turnId: string, belief: Belief, hooks: Phase2Hooks = {}): Promise<void> {
    const gen = this.rollbackGen;
    const rgen = this.resetGen;
    const cgen = this.commitGen;
    const superseded = (): boolean => gen !== this.rollbackGen || rgen !== this.resetGen || cgen !== this.commitGen;
    return this.enqueue(async () => {
      if (this.closed) throw new SpeculationFailed('executor closed');
      if (superseded()) return;
      const s = this.session;
      if (!s) return this.fail('no droid session');
      if (this.live?.turnId !== turnId || this.live.post1 === null) return this.fail('phase2 without phase1');
      const t0 = performance.now();
      const now = this.opts.now?.() ?? new Date();
      this.staged = null;
      // Early diff (R24) and STAGED (R25): each successful write result commits the working tree on
      // the branch and emits the files whose diff changed, so the branch holds exactly what is shown.
      // The first such commit calls onStaged. Jobs run one at a time so two quick writes don't race
      // git; one that starts after supersession does nothing.
      const emitted = new Map<string, string>();
      const emitDiffs = (diffs: { file: string; diff: string }[]): void => {
        for (const d of diffs) {
          if (emitted.get(d.file) === d.diff) continue;
          emitted.set(d.file, d.diff);
          this.opts.emit({ type: 'droid_event', turnId, kind: 'diff', payload: { file: d.file, diff: d.diff }, ts: Date.now() });
        }
      };
      let writes: Promise<void> = Promise.resolve();
      const onWrite = (): Promise<void> => {
        writes = writes
          .then(async () => {
            if (superseded() || this.closed) return;
            const diffs = await this.git.diffWorkingTree();
            if (superseded()) return;
            if (diffs.length === 0 || diffs.every((d) => emitted.get(d.file) === d.diff)) return;
            // Never show or stage an edit that still mentions a value the user corrected.
            if (mentionedSuperseded(diffs, belief) !== null) {
              console.log('[droid] write mentions a superseded value, not staged');
              return;
            }
            const sha = await this.git.commitAll('phase2-edit');
            // A commit or reset that arrived during commitAll resets the branch to the previous staged sha.
            if (superseded()) return;
            this.staged = { turnId, sha };
            const first = emitted.size === 0;
            emitDiffs(diffs);
            if (first) {
              this.metric('first-diff', performance.now() - t0);
              hooks.onStaged?.();
            }
          })
          .catch((e: unknown) => console.log(`[droid] early diff failed (${e instanceof Error ? e.name : 'unknown'})`));
        return writes;
      };
      const run = async (label: string, prompt: string) => {
        this.running = { turnId, phase: 'phase2' };
        const out = await this.timed(s, label, () =>
          runTurn(s, prompt, {
            turnId,
            guard: this.guard,
            emit: this.opts.emit,
            graceMs: this.opts.graceMs,
            onWrite,
          }),
        ).finally(() => {
          this.running = null;
        });
        // No early-diff git work may overlap commitAll, a reset or a rollback.
        await writes;
        return out;
      };
      let r = await run('phase2', phase2Prompt(belief, now));
      if (superseded()) return;
      if (r.outcome !== 'success') return this.failPhase2(turnId, `phase2 ${r.outcome}`);
      // Post-check: a draft that still mentions a corrected value is rejected and rerun once.
      if (mentionedSuperseded(await this.git.diffWorkingTree(), belief) !== null) {
        console.log('[droid] phase2 draft mentions a superseded value, rerunning once');
        this.metric('phase2-reject', performance.now() - t0);
        r = await run('phase2-fix', correctionFixPrompt(belief, now));
        if (superseded()) return;
        if (r.outcome !== 'success') return this.failPhase2(turnId, `phase2 fix ${r.outcome}`);
        if (mentionedSuperseded(await this.git.diffWorkingTree(), belief) !== null) {
          return this.failPhase2(turnId, 'phase2 draft still mentions a superseded value');
        }
      }
      let diffs: { file: string; diff: string }[];
      try {
        await this.git.commitAll('phase2');
        this.metric('phase2', performance.now() - t0);
        const td = performance.now();
        diffs = await this.git.diffFiles(turnId);
        this.metric('diff', performance.now() - td);
      } catch (e) {
        return this.failPhase2(turnId, 'git commit/diff failed', e);
      }
      emitDiffs(diffs);
      this.opts.emit({
        type: 'droid_event',
        turnId,
        kind: 'result',
        payload: { ok: true, summary: r.summary || 'staged' },
        ts: Date.now(),
      });
    });
  }

  // Generation bump and interrupt happen synchronously; the reset itself joins the chain in call order.
  resetToPhase1(turnId: string): Promise<void> {
    // queuedTurnId also covers a phase1 that is queued or still opening, so a queued phase2 is superseded.
    if (this.queuedTurnId === turnId) this.resetGen++;
    const interrupted = this.live?.turnId === turnId ? this.interruptRunning(['phase2']) : Promise.resolve();
    return this.enqueue(async () => {
      await interrupted;
      const post1 = this.live?.turnId === turnId ? this.live.post1 : null;
      if (post1 === null) {
        console.log('[droid] resetToPhase1: no phase1 commit for this turn, skipped');
        return;
      }
      try {
        await this.git.resetTo(post1);
      } catch (e) {
        return this.fail('git reset failed', e);
      }
    });
  }

  // Before staging, unchanged: R24 fail. After staging (R25): the shown diff stays on the branch,
  // dropping any half-landed later edit, and result failed:true tells the HUD it is stale.
  private async failPhase2(turnId: string, reason: string, cause?: unknown): Promise<never> {
    const staged = this.staged?.turnId === turnId ? this.staged.sha : null;
    if (staged !== null) {
      // Lengths and booleans only in logs; the summary is a fixed string.
      this.opts.emit({
        type: 'droid_event',
        turnId,
        kind: 'result',
        payload: { ok: false, failed: true, summary: 'droid turn failed after staging' },
        ts: Date.now(),
      });
      await this.git.resetTo(staged).catch(() => console.log('[droid] reset to staged commit failed'));
    }
    return this.fail(reason, cause);
  }

  // A commit while this turn's Phase 2 is still running (STAGED fired on the landed edit) supersedes
  // it synchronously, interrupts the turn, then on the chain resets the branch to the staged commit
  // so main gets exactly the diff the HUD showed (R25).
  commit(turnId: string): Promise<void> {
    const midPhase2 = this.running?.phase === 'phase2' && this.running.turnId === turnId;
    if (midPhase2) this.commitGen++;
    const interrupted = midPhase2 ? this.interruptRunning(['phase2']) : Promise.resolve();
    return this.enqueue(async () => {
      await interrupted;
      const t0 = performance.now();
      try {
        if (midPhase2) {
          // The superseded phase2 job (and its write jobs) finished before this one started.
          const sha = this.staged?.turnId === turnId ? this.staged.sha : this.live?.turnId === turnId ? this.live.post1 : null;
          if (sha !== null) await this.git.resetTo(sha);
        }
        await this.git.merge(turnId);
      } catch (e) {
        return this.fail('git merge failed', e);
      }
      await this.closeSession();
      if (this.live?.turnId === turnId) this.live = null;
      this.metric('commit', performance.now() - t0);
    });
  }

  rollback(turnId: string): Promise<void> {
    this.rollbackGen++;
    const interrupted = this.interruptRunning(['phase1', 'phase2']);
    return this.enqueue(async () => {
      await interrupted;
      await this.doRollback(turnId);
    });
  }

  // Shutdown, terminal: later warm() opens nothing and later phases throw. Already-queued work
  // drains first (a warm queued before close opens nothing), then the session closes. Leaves git as is.
  close(): Promise<void> {
    this.closed = true;
    return this.enqueue(() => this.closeSession());
  }

  // Runs on the chain. Leaves no live speculation: the named turn and any other live one are discarded.
  private async doRollback(turnId: string): Promise<void> {
    const t0 = performance.now();
    // On the chain, so no phase is streaming: rollback() interrupted a running one before joining,
    // and phase1's own pre-rollback runs between phases.
    await this.closeSession();
    const other = this.live && this.live.turnId !== turnId ? this.live.turnId : null;
    this.live = null;
    try {
      await this.git.discard(turnId);
      if (other !== null) await this.git.discard(other);
    } catch (e) {
      throw new SpeculationFailed('git discard failed', { cause: e });
    }
    this.metric('rollback', performance.now() - t0);
  }
}

// Production wiring: one sandbox settings file per process, real Droid sessions (exercised in Task 9).
export function createDroidExecutor(emit: Emit): DroidExecutor {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahead-droid-'));
  const settingsFile = writeSandboxSettings(dir, { home: os.homedir(), repoRoot: REPO_ROOT, workspace: WORKSPACE_DIR });
  return new DroidExecutor({
    workspace: WORKSPACE_DIR,
    emit,
    openSession: (permissionHandler, abortSignal) => openDroidSession({ permissionHandler, abortSignal, settingsFile }),
  });
}
