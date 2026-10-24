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
5. `workspace-seed/` with `calendar.json`, `contacts.json`, `notes/`, `messages/outbox/`, `files/` containing the demo facts from PLAN.md section 5. Plus `pnpm reset:workspace`, which deletes `var/workspace/`, copies the seed in, runs `git init`, and makes an initial commit on `main` inside it. `var/` is gitignored. Do NOT `git init` anywhere else.
6. Spikes, each as a tiny script in `apps/server/scripts/spike-*.ts` that proves the key works and prints latency: `spike-ink.ts` (stream a wav, print partials with timestamps), `spike-sonic.ts` (synthesize one line, save wav), `spike-moss.ts` (index 10 docs, query, print ms), `spike-droid.ts` (one-shot run that writes a file under var/workspace/ with a permission handler that denies everything outside it). Write findings to `docs/sdk-notes.md`.

Do not build features. Stop when all four spikes pass.

---

## Lane A: Voice pipeline (`lane/voice`, apps/server + apps/web audio bits)

Goal: mic in, Ink 2 partials out at ≤ 150 ms cadence, turn detection events, Sonic playback with barge-in.

Deliverables
1. Browser: AudioWorklet capturing 16 kHz PCM, chunked over WS as `audio_chunk`. Playback via AudioContext queue with a `stopNow()` that ramps gain to 0 in 30 ms (used for barge-in).
2. Server: `InkClient` wrapping Cartesia Ink 2 streaming STT. Emits `transcript_partial` on every partial, `transcript_final` + `turn_end` on Ink's native turn detection. Log cadence.
3. Server: `SonicClient` streaming TTS to `tts_audio_chunk`. Function `speak(text, {interrupt:boolean})`. When `interrupt`, pause forwarding audio to Ink for 1.5 s so the agent does not transcribe itself.
4. A `turnId` lifecycle: new id on first partial after a `turn_end`.
5. Test against the mock belief tracker: when mock emits `interject`, Sonic speaks over the user and STT resumes cleanly.

Done when: a human can talk, see partials appear word by word in a bare page, and hear a canned Sonic reply at turn end. Measure and record partial cadence and time-to-first-audio in `docs/sdk-notes.md`.

---

## Lane B: Retrieval + belief tracker (`lane/belief`, apps/server)

Goal: given a stream of partials, produce a stream of `Belief` objects, with Moss on the hot path.

Deliverables
1. `scripts/gen-corpus.ts`: generate 300 to 500 synthetic docs for one fictional user (calendar events, contacts, notes, emails, file summaries) with metadata `{type, date, people[]}`. Must include the demo facts from PLAN.md section 5 verbatim.
2. `MossIndex`: build index from corpus, load in-process at server start, `query(text, {k, filters})` returning hits + measured ms. Hybrid mode.
3. `BeliefTracker` (pure logic, TDD this):
   - `onPartial(turnId, text)`: diff against last partial, query Moss with the new text window (last ~12 tokens) and the full partial, merge into a recency-weighted accumulator per turn.
   - every 400 ms, if the partial changed, call Claude Haiku with `{partial, topHits}` and a strict JSON schema → `Belief`. Never block the Moss loop on this.
   - contradiction detection: when Haiku returns `claims` whose `said` conflicts with the `known` value from a top hit, and confidence ≥ 0.8, emit `interject` once per turn.
   - emits `belief_update` and `moss_hits` after every step.
   - `onTurnEnd(turnId, finalText)`: one Haiku call to confirm or revise the belief, returns final `Belief`.
4. Thresholds in one config object: `SPECULATE_AT=0.75`, `INTERJECT_AT=0.8`, `LLM_INTERVAL_MS=400`, `PARTIAL_DEBOUNCE_MS=100`.
5. Replay harness: feed a fixture of timed partials from the demo script and print the belief timeline. This is also the DEMO_MODE backbone.

Done when: on the demo fixture, belief locks `draft_message` + `person=Priya` before the word "Thursday" arrives, and the contradiction fires at "Thursday".

---

## Lane C: Executor (`lane/executor`, apps/server)

Goal: a `Speculator` that turns a belief into staged, reversible, visible work via the Factory Droid SDK.

Deliverables
1. `DroidExecutor` using `@factory/droid-sdk`:
   - `prepare(turnId)`: `git checkout -b spec/<turnId>` inside `var/workspace/`, create a Droid session with `cwd=var/workspace/`.
   - `speculate(turnId, belief)`: build a prompt from an action template (`reschedule_event`, `draft_message`, `add_note`, `find_file`) and run it. Stream every SDK event (plan text, tool use, tool result) to the WS as `droid_event`. After completion, compute `git diff main..spec/<turnId>` and emit as `droid_event kind:'diff'`.
   - Permission handler: allow read/write/edit only for paths under `var/workspace/`; deny Execute, network, and anything else. Deny must be logged and surfaced to UI as a `droid_event kind:'tool'` with `denied:true` so judges see the safety layer working.
   - `commit(turnId)`: fast-forward merge to main, emit `state_change COMMITTED`.
   - `rollback(turnId)`: `session.abort()`, checkout main, delete branch, emit `state_change ROLLED_BACK`.
   - Hard rule: at most one live speculation per turn. A new `speculate` for the same turn must rollback first.
2. `StateMachine` (TDD): LISTENING → BELIEF_FORMING → SPECULATING → STAGED → COMMITTED | ROLLED_BACK, with the transitions driven by belief confidence and turn events. Emits `state_change`.
3. Action templates in `apps/server/src/actions/*.md`. Each is explicit about which file to edit and must end with "Do not run commands. Do not touch files outside this workspace."
4. Test with the mock belief stream from contracts.

Done when: a mock belief for `reschedule_event` produces a real edit to `var/workspace/calendar.json` on a branch, the diff appears in the event stream within ~5 s, and both commit and rollback leave `var/workspace/` in a clean state. Record Droid cold-start and typical task latency in `docs/sdk-notes.md`.

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
