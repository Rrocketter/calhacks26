// Live check of the correction fix with real Droid: utterance 1's belief (spoken "Thursday", with the
// spoken words also in a message slot), the accepted correction to Friday applied by correctBelief,
// then Phase 1 and Phase 2 on a fresh workspace. Pass = the draft names Friday and never Thursday.
// Needs AHEAD_WORKSPACE (a scratch workspace; reset each trial). Prints booleans and counts only.
// --control reproduces the old correction (day fixed, message slot untouched, no correction line).
// Usage: AHEAD_WORKSPACE=... correction-trials.ts [--trials=5] [--control]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BeliefSchema, type Belief, type Claim, type ServerEvent } from '@ahead/contracts';

const CONTROL = process.argv.includes('--control');
const TRIALS = Number(process.argv.find((a) => a.startsWith('--trials='))?.split('=')[1] ?? 5);
if (!process.env.AHEAD_WORKSPACE) {
  console.log('set AHEAD_WORKSPACE to a scratch workspace');
  process.exit(1);
}
const { REPO_ROOT, WORKSPACE_DIR } = await import('../src/env.js');
const { createDroidExecutor } = await import('../src/executor/droid-executor.js');
const { correctBelief } = await import('../src/reply.js');

const CLAIM: Claim = { field: 'day', said: 'Thursday', known: 'Friday', docId: 'evt-priya-q3' };
const SPOKEN: Belief = BeliefSchema.parse({
  intent: 'draft_message',
  entities: {
    person: 'Priya Shah',
    day: 'thursday',
    time: '2',
    message: "I'll see her Thursday at 2 for the Q3 deck review",
  },
  claims: [CLAIM],
  confidence: 0.9,
  topHits: [],
  latencyMs: { moss: 2 },
});
const fixed = correctBelief(SPOKEN, CLAIM, new Date());
const CORRECTED: Belief = CONTROL
  ? { ...SPOKEN, entities: { ...SPOKEN.entities, day: fixed.entities.day!, weekday: fixed.entities.weekday!, date_iso: fixed.entities.date_iso! } }
  : fixed;
const DRAFT = path.join(WORKSPACE_DIR, 'messages', 'outbox', 'priya.md');

const reset = () => execFileSync('pnpm', ['reset:workspace'], { cwd: REPO_ROOT, stdio: 'ignore' });

const events: ServerEvent[] = [];
const exec = createDroidExecutor((e) => events.push(e));
await exec.warm();
let passes = 0;
for (let i = 1; i <= TRIALS; i++) {
  reset();
  events.length = 0;
  const turnId = `corr-${i}`;
  let staged = 0;
  let note = '';
  const t0 = performance.now();
  try {
    await exec.phase1(turnId, SPOKEN);
    await exec.phase2(turnId, CORRECTED, { onStaged: () => void staged++ });
  } catch (err) {
    note = `phase2 failed (${err instanceof Error ? err.name : 'error'})`;
  }
  const ms = Math.round(performance.now() - t0);
  const text = fs.existsSync(DRAFT) ? fs.readFileSync(DRAFT, 'utf8') : '';
  const friday = /\bfriday\b/i.test(text);
  const thursday = /\bthursday\b/i.test(text);
  const reruns = events.filter((e) => e.type === 'metric' && e.label === 'phase2-reject').length;
  const shownThursday = events.some(
    (e) => e.type === 'droid_event' && e.kind === 'diff' && /^\+.*\bthursday\b/im.test(String((e.payload as { diff?: string }).diff)),
  );
  const ok = !note && friday && !thursday && !shownThursday && staged === 1;
  if (ok) passes++;
  console.log(
    `trial ${i}: ${ok ? 'PASS' : 'FAIL'} friday=${friday} thursday=${thursday} rerun=${reruns} staged=${staged} thursdayDiffShown=${shownThursday} ${ms}ms${note ? ` ${note}` : ''}`,
  );
  await exec.rollback(turnId).catch(() => undefined);
}
await exec.close();
reset();
console.log(`--- ${passes}/${TRIALS} pass${CONTROL ? ' (control: old correction)' : ''} ---`);
process.exit(0);
