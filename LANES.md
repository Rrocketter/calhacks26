# Lane briefs

Each brief is meant to be pasted (or pointed at via `docs/lanes/<name>.md`) as the opening message of a Claude Code session running in its own worktree. Every session should open with: "Read PLAN.md and CLAUDE.md, then this brief. Use /write-plan then /execute-plan."

---

## Lane 0: Scaffold + contracts (run FIRST, alone, Fri 8 to 10 PM, main branch)

Goal: a monorepo where three lanes can build in parallel without touching each other.

Deliverables
1. pnpm workspace with `apps/server`, `apps/web`, `packages/contracts`. TypeScript strict. Build + lint scripts. `.env.example`. `pnpm check:secrets`.
2. `packages/contracts/src/events.ts`: the full WebSocket event schema, client→server and server→client, using zod. Events at minimum:
   - c2s: `audio_chunk`, `demo_control`, `confirm_action {turnId, apply:boolean}`
   - s2c: `transcript_partial {turnId,text,ts}`, `transcript_final`, `turn_start`, `turn_end`, `belief_update {turnId, belief:Belief}`, `moss_hits {turnId, hits, latencyMs}`, `state_change {turnId, state}`, `droid_event {turnId, kind:'plan'|'step'|'tool'|'diff'|'result', payload}`, `interject {turnId, text}`, `tts_audio_chunk`, `error`
3. `packages/contracts/src/belief.ts`: the `Belief` type from PLAN.md, the `Intent` enum, the `State` enum.
4. `packages/contracts/mocks/`: a mock Ink partial stream (reads a JSON fixture of timed partials), a mock Moss (returns canned hits), a mock Droid (emits a fake plan + 3 steps + a diff over 2 s). Each lane uses the others' mocks.
5. `workspace-seed/` with `calendar.json`, `contacts.json`, `notes/`, `messages/outbox/`, `files/` containing the demo facts from PLAN.md section 5. Plus `pnpm reset:workspace`, which deletes `~/.ahead/workspace/`, copies the seed in, runs `git init`, and makes an initial commit on `main` inside it. Do NOT `git init` anywhere else.
6. Spikes, each as a tiny script in `apps/server/scripts/spike-*.ts` that proves the key works and prints latency: `spike-ink.ts` (stream a wav, print partials with timestamps), `spike-sonic.ts` (synthesize one line, save wav), `spike-moss.ts` (index 10 docs, query, print ms), `spike-droid.ts` (one-shot run that writes a file under ~/.ahead/workspace/ with a permission handler that denies everything outside it). Write findings to `docs/sdk-notes.md`.

Do not build features. Stop when all four spikes pass.

---

## Lane A: Voice pipeline (`lane/voice`, apps/server + apps/web audio bits)

Goal: mic in, Ink 2 `turn.update` out at ~250 ms cadence (measured), turn events, Sonic playback with barge-in.

Deliverables
1. Browser: AudioWorklet capturing 16 kHz PCM, chunked over WS as `audio_chunk`. Playback via AudioContext queue with a `stopNow()` that ramps gain to 0 in 30 ms (used for barge-in).
2. Server: `InkClient` wrapping Cartesia Ink 2 streaming STT. Emits `transcript_partial` on every `turn.update`, and surfaces `turn.eager_end` (finalize trigger), `turn.resume` (un-finalize), `turn.end` (closes the turn; emits `transcript_final` + `turn_end`). Also emit `turn_eager_end` / `turn_resume`. Log cadence.
3. Server: `SonicClient` streaming TTS (WebSocket, `sonic-3.6`) to `tts_audio_chunk`. Function `speak(text, {interrupt:boolean})`. When `interrupt`, pause forwarding audio to Ink for 1.5 s so the agent does not transcribe itself.
4. A `turnId` lifecycle: new id on Ink `turn.start` (always the first event of a turn). `turn.resume` keeps the same id.
5. Test against `mockBeliefStream` from `@ahead/contracts/mocks`: when it emits `interject`, Sonic speaks over the user and STT resumes cleanly. `mockInkStream` replays an Ink fixture (`loadFixture('demo-utterance-1')` from `@ahead/contracts/mocks/node`, or import `@ahead/contracts/mocks/fixtures/demo-utterance-1.json` in the browser). `MockMoss` and `mockDroidRun` stand in for Lanes B and C.

Done when: a human can talk, see partials appear word by word in a bare page, and hear a canned Sonic reply at turn end. Measure and record partial cadence and time-to-first-audio in `docs/sdk-notes.md`.

---

## Lane B: Retrieval + belief tracker (`lane/belief`, apps/server)

Goal: given a stream of partials, produce a stream of `Belief` objects, with Moss on the hot path.

Deliverables
1. `scripts/gen-corpus.ts`: generate 300 to 500 synthetic docs for one fictional user (calendar events, contacts, notes, emails, file summaries) with metadata `{type, date, people[]}`. Must include the demo facts from PLAN.md section 5 verbatim.
2. `MossIndex`: build index from corpus, load in-process at server start, `query(text, {k, filters})` returning hits + measured ms. Hybrid mode.
3. `BeliefTracker` (pure logic, TDD this):
   - `onUpdate(turnId, text)` (driven by Ink `turn.update`, ~250 ms): normalize text first (Ink writes "two" as "2" and adds punctuation), then 3-4 Moss queries: full text, last ~6 words, one per extracted entity. Merge into a recency-weighted accumulator per turn. ~60 queries per utterance at ~2 ms (3-4 queries per update, ~4 updates/s, for a ~4-5 s utterance; measured p50 2.0 ms / p95 2.4 ms).
   - on every Nth update, if the text changed, call Claude Haiku with `{partial, topHits}` and a strict JSON schema → `Belief`. Never block the Moss loop on this.
   - contradiction detection: when Haiku returns `claims` whose `said` conflicts with the `known` value from a top hit, and confidence ≥ 0.8, emit `interject` once per turn.
   - emits `belief_update` and `moss_hits` after every step.
   - `onEagerEnd(turnId, text)` finalizes slots (trigger for Phase 2); `onResume(turnId)` un-finalizes; `onTurnEnd(turnId, finalText)`: one Haiku call to confirm or revise the belief, returns final `Belief`.
4. Thresholds in one config object: `SPECULATE_AT=0.75`, `INTERJECT_AT=0.8`, `LLM_EVERY_N_UPDATES`.
5. Replay harness: feed a fixture of timed partials from the demo script and print the belief timeline. This is also the DEMO_MODE backbone.

Done when: on the demo fixture, belief locks `draft_message` + `person=Priya` before the word "Thursday" arrives, and the contradiction fires at "Thursday".

---

## Lane C: Executor (`lane/executor`, apps/server)

Goal: a `Speculator` that turns a belief into staged, reversible, visible work via the Factory Droid SDK.

Deliverables
1. `DroidExecutor` using `@factory/droid-sdk`:
   - Pre-create a warm Droid session at LISTENING with `cwd=~/.ahead/workspace/` (not tied to a turnId; create 0.9 s warm / 2.2 s cold). `prepare(turnId)` runs at belief lock, after turn.start assigns the turnId: `git checkout -b spec/<turnId>` inside `~/.ahead/workspace/`. On turn.resume, interrupt any running Phase 2 prompt and reset the spec branch to its post-Phase-1 commit; the next turn.eager_end sends Phase 2 again.
   - `speculate(turnId, belief)`, two phases in the same session. Phase 1 at belief lock: "open the target file, find the record, plan the edit, wait for details". Phase 2 at `turn.eager_end`: send the final slot values as a second turn. Build prompts from an action template (`reschedule_event`, `draft_message`, `add_note`, `find_file`). Stream every SDK event (plan text, tool use, tool result) to the WS as `droid_event`. After completion, compute `git diff main..spec/<turnId>` and emit as `droid_event kind:'diff'`.
   - Permission handler: gates writes only. Return `ProceedOnce` for Create/Edit/ApplyPatch whose paths resolve inside `~/.ahead/workspace/`, `Cancel` for everything else. Read/LS never reach it, so it is not the read control (the sandbox is, see Confinement). Every deny must be logged and surfaced to the UI as a `droid_event kind:'tool'` with `denied:true` (payload type `DroidToolPayload` in contracts) so judges see the safety layer working.
   - `commit(turnId)`: fast-forward merge to main, emit `state_change COMMITTED`.
   - `rollback(turnId)`: `session.interrupt()`, then `session.close()` (the 0.10.0 SDK has no `abort()`), checkout main, delete branch, emit `state_change ROLLED_BACK`.
   - Confinement (details and measurements in `docs/sdk-notes.md`, Droid section and its Lane C rule):
     - Read control: Droid's sandbox. Start every session with a per-session settings file (`execArgs: ['--settings', file]`): denyRead `$HOME` + repo + secret dirs, allowRead the workspace, denyWrite `.git`. Check `session.settings.sandbox.enabled` before the first prompt.
     - Tool allowlist: exactly `Create, Edit, Read, TodoWrite, ToolSearch` (`disabledToolIds` for the rest). Check the `listTools()` allowed set before the first prompt.
     - Watchdog: on any tool name outside the allowlist or any path outside the workspace, emit the denied `droid_event`, call `session.interrupt()`, then `session.close()`. It is detection plus a fast stop, not the control.
     - Child env: the SDK merges `env` over `process.env`, so pass an allowlist (`FACTORY_API_KEY, PATH, HOME, TMPDIR, LANG, USER, SHELL`) with every other key set to `undefined`. Copy `droidChildEnv()` from `apps/server/scripts/spike-droid.ts`.
   - Hard rule: at most one live speculation per turn. A new `speculate` for the same turn must rollback first.
2. `StateMachine` (TDD): LISTENING → BELIEF_FORMING → SPECULATING → STAGED → COMMITTED | ROLLED_BACK, with the transitions driven by belief confidence and turn events. Emits `state_change`.
3. Action templates in `apps/server/src/actions/*.md`. Each is explicit about which file to edit and must end with "Do not run commands. Do not touch files outside this workspace."
4. Test with `mockBeliefStream` and `mockDroidRun` from `@ahead/contracts/mocks`. `mockDroidRun(turnId, { withDenied: true })` adds one denied `tool` event.

Done when: a mock belief for `reschedule_event` produces a real edit to `~/.ahead/workspace/calendar.json` on a branch, the diff appears in the event stream within ~5 s, and both commit and rollback leave `~/.ahead/workspace/` in a clean state. Record Droid cold-start and typical task latency in `docs/sdk-notes.md`.

---

## Lane D: HUD + demo polish (`lane/ui`, apps/web, start Sat ~noon once A and B have real events)

Goal: the thing judges look at. One screen, dark, no scrolling, legible from 4 feet away.

Layout (left to right)
1. Transcript column: partial text grows word by word, finalized turns above it. The word that triggered an interjection gets highlighted.
2. Belief panel: intent as a big label, confidence as a bar that visibly rises across the sentence, entities as chips, top 3 Moss hits with snippet and `ms` badge.
3. Executor panel: state machine as a horizontal stepper, Droid plan/steps streaming in, denied tool calls shown in red, diff rendered as a real diff view, Apply / Discard buttons (voice "yes" also works).
4. Top bar: live counters, "Moss queries this turn", "avg retrieval ms", "time to first audio".

Also
- `DEMO_MODE` toggle that drives the whole UI from the replay harness.
- 30 s screen recording of utterance 1 for the Moss social post.
- Read the superpowers frontend-design skill if present, keep one accent color, use a monospace for the HUD numbers.

---

## Integration (human, main branch)
1. Merge Lane 0 → A → B → C in that order Sat afternoon. Replace mocks with real modules behind the same interfaces.
2. Run the demo fixture end to end in DEMO_MODE, then live.
3. Tune `SPECULATE_AT` and `INTERJECT_AT` on the three demo utterances only.
4. Freeze features Sat 11 PM. Everything after is video, README, Devpost, rehearsal.
