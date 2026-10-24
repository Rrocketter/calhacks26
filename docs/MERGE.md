# Morning merge plan (written overnight, Sat Oct 24)

## Overnight verdict
All three lanes merge. I did a full trial merge in a throwaway clone: voice merged clean, belief and executor each conflicted only in `apps/server/package.json` (scripts list) and `docs/sdk-notes.md` (both lanes appended sections at the same spot). Both are keep-both-sides. The merged tree **builds, lints (after one 2-file patch), and passes 277/277 server tests + contracts tests**. `pnpm install --frozen-lockfile` works, so the lockfile merged cleanly too.

One lint error appeared only after merge: voice's tsconfig change makes lint type-check test files, and two executor tests use `t.mock` on a `beforeEach` context typed as `TestContext | SuiteContext`. Patch in `docs/patches/0001-executor-test-context-type.patch`.

## Step 1: merge (you, in Terminal, ~5 min)

```bash
cd ~/Developer/calhacks26
git merge --no-edit lane/voice
git merge --no-edit lane/belief        # conflicts: package.json, sdk-notes.md
```
Resolve `apps/server/package.json`: take the **executor-style** test glob and keep every script from both sides. The final scripts block should be exactly:
```json
"test": "node --import tsx --test scripts/*.test.ts src/*/*.test.ts",
"gen:corpus": "node --import tsx scripts/gen-corpus.ts",
"build:index": "MOSS_DISABLE_TELEMETRY=1 node --env-file=../../.env --import tsx scripts/build-index.ts",
"replay": "MOSS_DISABLE_TELEMETRY=1 node --env-file=../../.env --import tsx scripts/replay.ts",
"spike:ink": "node --env-file=../../.env --import tsx scripts/spike-ink.ts",
"spike:sonic": "node --env-file=../../.env --import tsx scripts/spike-sonic.ts",
"spike:moss": "MOSS_DISABLE_TELEMETRY=1 node --env-file=../../.env --import tsx scripts/spike-moss.ts",
"spike:droid": "node --env-file=../../.env --import tsx scripts/spike-droid.ts",
"smoke:sonic-ws": "node --env-file=../../.env --import tsx scripts/smoke-sonic-ws.ts",
"smoke:voice": "node --import tsx scripts/smoke-voice.ts",
"smoke:executor": "node --env-file=../../.env --import tsx scripts/smoke-executor.ts"
```
(The belief merge won't have `smoke:executor` yet; add it at the executor merge.)
Resolve `docs/sdk-notes.md`: delete the three marker lines, keep both blocks.
```bash
git add -A && git commit -m "merge lane/belief"
git merge --no-edit lane/executor      # same two files, same resolution
git add -A && git commit -m "merge lane/executor"
git apply docs/patches/0001-executor-test-context-type.patch
pnpm install && pnpm -r build && pnpm -r lint && pnpm -r test && pnpm check:secrets
git add -A && git commit -m "fix(executor): type test context for lint" && git push
```
Easier alternative: hand Step 1 to the integrator session with "follow docs/MERGE.md Step 1 exactly". It works either way.

## Step 2: what integration has to wire (the integrator session's job)
`apps/server/src/index.ts` currently wires **voice only**. Belief and executor exist as finished modules but nothing connects them. The glue is small because every lane exposes a clean API:

| From | Event | To |
|---|---|---|
| VoiceSession `send` | `transcript_partial` | `tracker.onUpdate(turnId, text)` |
| VoiceSession `send` | `turn_eager_end` | `tracker.onEagerEnd(...)` and `speculator.onServerEvent(ev)` |
| VoiceSession `send` | `turn_resume` | `tracker.onResume(...)` and `speculator.onServerEvent(ev)` |
| VoiceSession `send` | `turn_end` | `tracker.onTurnEnd(turnId, final)` and `speculator.onServerEvent(ev)` |
| tracker `emit` | `belief_update`, `moss_hits` | ws **and** `speculator.onServerEvent(ev)` |
| tracker `emit` | `interject` | `session.handleInterject(turnId, text)` (voice speaks it, mutes mic) |
| speculator `emit` | `state_change`, `droid_event` | ws |
| speculator `emit` | `state_change STAGED` | Sonic speaks a short summary + "apply?" |
| client | `confirm_action` | `speculator.onConfirm(turnId, apply)` |
| voice `turn_end` | replace `TURN_END_REPLY` ("Got it, I heard you") | belief-driven reply: for `lookup`, a Haiku answer from top hits; for a speculating intent, nothing (STAGED speaks); for unknown, a short fallback |

Startup (once, before accepting connections): `MossIndex.load('ahead-corpus')` (2 to 20 s), one Haiku warm-up call, `executor.warm()` so a Droid session is already open. Keep `AHEAD_MOCK_BELIEF` working but move it under `DEMO_MODE`.

Also: add `failed?: boolean` to `DroidResultPayload` in `packages/contracts/src/droid.ts` (executor already emits it; type just doesn't declare it).

Voice deferred one edge to integration: a repeated `turn.start` replaces the turn id without closing the old turn. Integrator should emit a synthetic `turn_end` for the old id first so belief and executor don't leak an open turn.

## Step 3: the mic test (you, 10 min, after Step 2 Tier 1 works)
Voice lane's checklist is in its final report; the short version: run server + web, say utterance 2, confirm partials, reply audio clean on first syllable, no self-transcription. Then `AHEAD_MOCK_BELIEF=1`, say utterance 1, confirm one interjection. Paste TTFA numbers into sdk-notes "Lane A live measurements".

## Numbers to carry into the README and pitch (all measured)
- Moss: ~2 ms per warm query, ~50 queries per utterance, p50 19 ms per Ink update step (first query per step is 10 to 20 ms, unexplained). Say "about 50 in-process queries per sentence, single-digit ms each once warm". Do not say "2 ms every query".
- Ink 2: update every ~250 ms, `eager_end` 100 to 345 ms before `turn.end`.
- Sonic: 68 to 85 ms time-to-first-audio with a warm socket.
- Haiku: 1.2 to 1.6 s warm. Belief locks ~1.9 s into the sentence on the fixture, interjection fires on the "Thursday" partial, 9/9 runs.
- Droid: belief lock to STAGED 13 to 18 s (Phase 1 runs while you talk; edit lands 5 to 6 s into Phase 2). Narrate utterance 2 as "it's already working" with the plan streaming, not "it's done when I stop".

## Lane D (UI) brief is unchanged: `docs/lanes/ui.md`. Start it right after Step 1 so it builds against real events.

## Housekeeping
- Delete `.superpowers/sdd/` folders in each worktree whenever (gitignored).
- Never run `git worktree prune` or `git worktree add` from the Claude chat shell; it can't see the Mac paths and un-registers the lane worktrees. (Happened overnight, fully repaired, branches and files were never at risk.)
