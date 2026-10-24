// Live end-to-end smoke for the Droid executor (Lane C, Task 9): a real Speculator over a real
// DroidExecutor, driven by a fixture reschedule_event belief. Run A commits, Run B rolls back.
// Uses a lane-private workspace (~/.ahead/workspace-executor) and never touches ~/.ahead/workspace.
// Never prints model text, summaries, diff bodies or env values: kinds, names, lengths, booleans.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BeliefSchema, parseServerEvent, type Belief, type ServerEvent } from '@ahead/contracts';

// First statement that runs after the (env-free) static imports: env.ts resolves WORKSPACE_DIR at
// import time, so every module that reads it is loaded below with dynamic import.
const PRIVATE_WORKSPACE = path.join(os.homedir(), '.ahead', 'workspace-executor');
process.env.AHEAD_WORKSPACE = PRIVATE_WORKSPACE;

const NEW_DATE = '2026-11-02';
const EXPECT_START = '2026-11-02T09:00:00-08:00';
const EXPECT_END = '2026-11-02T10:00:00-08:00';
const EVENT_ID = 'evt-priya-q3';
const EVENT_FILE = 'calendar/evt-priya-q3.json'; // one file per event (scripts/calendar-layout.mjs)

const BELIEF: Belief = BeliefSchema.parse({
  intent: 'reschedule_event',
  entities: {
    person: 'Priya',
    event: 'Q3 deck review with Priya',
    from: 'Friday 2026-10-30 2 PM',
    date: 'Monday 2026-11-02',
    time: '9:00 AM',
  },
  claims: [],
  confidence: 0.86,
  topHits: [],
  latencyMs: { moss: 2 },
});

type DroidEv = Extract<ServerEvent, { type: 'droid_event' }>;

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

function describe(ev: ServerEvent, ws: string): string {
  switch (ev.type) {
    case 'droid_event': {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const bits = [`kind=${ev.kind}`];
      if (ev.kind === 'tool') {
        bits.push(`tool=${String(p.tool)}`);
        if (typeof p.path === 'string') bits.push(`path=${path.isAbsolute(p.path) ? path.relative(ws, p.path) || '.' : p.path}`);
        if (ev.denied) bits.push(`denied reason=${String(p.reason)}`);
      } else if (ev.kind === 'plan') {
        bits.push(`steps=${Array.isArray(p.steps) ? p.steps.length : 0}`);
      } else if (ev.kind === 'step') {
        bits.push(`len=${typeof p.text === 'string' ? p.text.length : 0}`);
      } else if (ev.kind === 'diff') {
        bits.push(`file=${String(p.file)} len=${typeof p.diff === 'string' ? p.diff.length : 0}`);
      } else if (ev.kind === 'result') {
        // failed:true (R25) marks a staged diff stale; reported, not a smoke failure.
        if (p.failed === true) bits.push('failed=true');
        else bits.push(`ok=${String(p.ok)} summaryLen=${typeof p.summary === 'string' ? p.summary.length : 0}`);
      }
      return `droid_event ${bits.join(' ')}`;
    }
    case 'state_change':
      return `state_change ${ev.state}`;
    case 'metric':
      return `metric ${ev.source} ${ev.label} ${Math.round(ev.ms)}ms`;
    case 'error':
      return `error source=${ev.source ?? '-'} msgLen=${ev.message.length}`;
    default:
      return ev.type;
  }
}

interface RunResult {
  name: string;
  pass: boolean;
  metrics: Record<string, number>;
  lockToDiff: number | null;
}

async function main(): Promise<void> {
  const { REPO_ROOT, WORKSPACE_DIR } = await import('../src/env.js');
  if (!WORKSPACE_DIR.endsWith('workspace-executor')) throw new Error('WORKSPACE_DIR is not the lane-private workspace');
  if (!process.env.FACTORY_API_KEY) throw new Error('missing env FACTORY_API_KEY');
  const { createDroidExecutor } = await import('../src/executor/droid-executor.js');
  const { Speculator } = await import('../src/executor/speculator.js');

  const ws = WORKSPACE_DIR;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', ws, '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv(), encoding: 'utf8' });
  const specBranches = (): string[] =>
    git('for-each-ref', '--format=%(refname:short)', 'refs/heads/spec/').split('\n').filter(Boolean);
  const branch = (): string => git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const clean = (): boolean => git('status', '--porcelain').trim() === '';
  const calendar = (): string => fs.readFileSync(path.join(ws, EVENT_FILE), 'utf8');
  const { readCalendar } = await import('../../../scripts/calendar-layout.mjs');
  const seedCalendar = JSON.stringify(readCalendar(path.join(REPO_ROOT, 'workspace-seed'))!.find((e) => e.id === EVENT_ID), null, 2) + '\n';

  const reset = (): void => {
    const t0 = performance.now();
    execFileSync('pnpm', ['reset:workspace'], {
      cwd: REPO_ROOT,
      env: { ...process.env, AHEAD_WORKSPACE: PRIVATE_WORKSPACE },
      stdio: 'ignore',
    });
    console.log(`[smoke] reset:workspace (private) ${Math.round(performance.now() - t0)}ms`);
  };

  const preflight = (): void => {
    if (!fs.existsSync(path.join(ws, '.git'))) throw new Error('workspace has no .git');
    if (branch() !== 'main') throw new Error('workspace not on main');
    if (!clean()) throw new Error('workspace not clean');
  };

  async function run(name: string, apply: boolean): Promise<RunResult> {
    console.log(`\n=== run ${name} (${apply ? 'commit' : 'rollback'}) ===`);
    reset();
    preflight();
    const turnId = `smoke-${name}-${Date.now()}`;
    const events: ServerEvent[] = [];
    const metrics: Record<string, number> = {};
    let invalid = 0;
    let lockAt: number;
    let eagerAt: number | undefined;
    // First diff event (early diff, R24) and the result event (end-of-phase diff point).
    let diffAt: number | null = null;
    let resultAt: number | null = null;
    let stagedAt: number | null = null;
    const emit = (ev: ServerEvent): void => {
      events.push(ev);
      if (parseServerEvent(JSON.stringify(ev)) === null) {
        invalid++;
        console.log(`[event] INVALID type=${ev.type}`);
        return;
      }
      if (ev.type === 'metric' && ev.source === 'droid' && !(ev.label in metrics)) metrics[ev.label] = ev.ms;
      if (ev.type === 'droid_event' && ev.kind === 'diff' && diffAt === null) diffAt = performance.now();
      if (ev.type === 'droid_event' && ev.kind === 'result' && resultAt === null) resultAt = performance.now();
      console.log(`[event] ${describe(ev, ws)}`);
      if (ev.type === 'state_change' && ev.state === 'STAGED' && stagedAt === null) {
        stagedAt = performance.now();
        // Run A confirms the moment STAGED shows, while the Phase 2 turn may still be running (R25).
        // Deferred so the confirm is not fed re-entrantly from inside the Speculator's own feed.
        if (apply) setImmediate(() => spec.onConfirm(turnId, true));
      }
    };
    const exec = createDroidExecutor(emit);
    const spec = new Speculator(exec, emit);
    const fail: string[] = [];
    try {
      spec.start();
      await spec.idle();
      spec.onServerEvent({ type: 'turn_start', turnId, ts: Date.now() });
      lockAt = performance.now();
      spec.onServerEvent({ type: 'belief_update', turnId, belief: BELIEF });
      await spec.idle(); // Phase 1 done before eager end, so the two phases time separately.
      eagerAt = performance.now();
      spec.onServerEvent({ type: 'turn_eager_end', turnId, text: '', ts: Date.now() });
      await spec.idle();
      spec.onServerEvent({ type: 'turn_end', turnId, ts: Date.now() });
      await spec.idle();
      if (!apply) spec.onConfirm(turnId, false);
      await spec.idle();
    } finally {
      await exec.close();
      await spec.idle();
    }

    const check = (ok: boolean, label: string): void => {
      console.log(`[check] ${ok ? 'ok  ' : 'FAIL'} ${label}`);
      if (!ok) fail.push(label);
    };
    const diffs = events.filter((e): e is DroidEv => e.type === 'droid_event' && e.kind === 'diff');
    // Last one: an early diff may be re-emitted at turn end.
    const calDiff = diffs.filter((d) => (d.payload as { file?: string }).file === EVENT_FILE).at(-1);
    const states = events.flatMap((e) => (e.type === 'state_change' ? [e.state] : []));
    const finalState = states.at(-1);
    // belief-lock-to-diff keeps its old meaning: the turn-end diff, emitted right before `result`.
    const lockToDiff = resultAt === null ? null : (resultAt as number) - lockAt;
    const lockToFirstDiff = diffAt === null ? null : (diffAt as number) - lockAt;
    const phase2ToFirstDiff = diffAt === null || eagerAt === undefined ? null : (diffAt as number) - eagerAt;
    const lockToStaged = stagedAt === null ? null : (stagedAt as number) - lockAt;
    const fmt = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v)}ms`);

    check(invalid === 0, `all events valid (invalid=${invalid})`);
    check(calDiff !== undefined, `diff event for ${EVENT_FILE}`);
    check(calDiff !== undefined && (calDiff.payload as { diff: string }).diff.includes(NEW_DATE), `${EVENT_FILE} diff contains ${NEW_DATE}`);
    check(diffs.every((d) => (d.payload as { file?: string }).file === EVENT_FILE), `diff touches only ${EVENT_FILE} (${diffs.length} files)`);
    check(!events.some((e) => e.type === 'droid_event' && e.denied), 'no denied tool calls');
    check(finalState === (apply ? 'COMMITTED' : 'ROLLED_BACK'), `final state ${finalState ?? 'none'}`);
    check(clean(), 'git status --porcelain empty');
    check(branch() === 'main', `on main (${branch()})`);
    check(specBranches().length === 0, `no spec/* branches (${specBranches().length})`);
    if (apply) {
      let ev: { start?: string; end?: string } | undefined;
      try {
        ev = JSON.parse(calendar()) as { start?: string; end?: string };
      } catch {
        ev = undefined;
      }
      check(calendar().includes(NEW_DATE), `${EVENT_FILE} on main contains ${NEW_DATE}`);
      check(ev?.start === EXPECT_START && ev?.end === EXPECT_END, `${EVENT_ID} start/end = ${ev?.start ?? '?'} / ${ev?.end ?? '?'}`);
    } else {
      check(calendar() === seedCalendar, `${EVENT_FILE} identical to workspace-seed`);
    }

    const ms = (label: string): string => (label in metrics ? `${Math.round(metrics[label]!)}ms` : 'n/a');
    console.log(
      `[latency] ${name} createSession=${ms('createSession')} phase1=${ms('phase1')} phase2=${ms('phase2')} diff=${ms('diff')} ` +
        `phase2-to-first-diff=${fmt(phase2ToFirstDiff)} lock-to-first-diff=${fmt(lockToFirstDiff)} ` +
        `lock-to-staged=${fmt(lockToStaged)} belief-lock-to-diff=${fmt(lockToDiff)} ${apply ? `commit=${ms('commit')}` : `rollback=${ms('rollback')}`}`,
    );
    const pass = fail.length === 0;
    console.log(`${pass ? 'PASS' : 'FAIL'} run ${name}${pass ? '' : `: ${fail.join('; ')}`}`);
    return { name, pass, metrics, lockToDiff };
  }

  const results: RunResult[] = [];
  try {
    results.push(await run('commit', true));
    results.push(await run('rollback', false));
  } finally {
    // A failing reset must not mask the run's own error.
    try {
      reset();
    } catch (e) {
      console.error(`[smoke] final reset:workspace failed (${e instanceof Error ? e.name : 'error'})`);
      process.exitCode = 1;
    }
  }
  const allPass = results.length === 2 && results.every((r) => r.pass);
  console.log(`\n${allPass ? 'PASS' : 'FAIL'} smoke:executor`);
  if (!allPass) process.exitCode = 1;
}

// Unconditional: no isMain guard. import.meta.url is realpath'd and argv[1] is not, so a guard
// silently skips main() (exit 0) when the repo is reached through a symlink. Nothing imports this file.
main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  let safe = msg.replace(/\s+/g, ' ');
  for (const v of Object.values(process.env)) if (v && v.length >= 8) safe = safe.split(v).join('[redacted]');
  console.error(`[smoke] FAILED ${e instanceof Error ? e.name : 'error'}: ${safe.slice(0, 200)}`);
  process.exit(1);
});
