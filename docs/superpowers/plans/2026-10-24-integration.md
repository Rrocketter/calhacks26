# Integration (MERGE.md Step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `Orchestrator` per WebSocket connection routes voice, belief and executor events per the MERGE.md Step 2 table, speaks belief-driven replies, and runs the full loop headless under `DEMO_MODE=1` from Ink fixtures.

**Architecture:** `src/orchestrator.ts` is pure routing over small ports (voice, tracker, speculator, speaker, answerer), unit-tested with fakes. `src/index.ts` does startup (Moss load, Haiku warm-up, `executor.warm()`, then listen) and builds the real objects per connection. In `DEMO_MODE` the Ink client is replaced by a fixture player that feeds the same `InkMessage`s into `VoiceSession.handleInk`, so everything downstream of Ink is the live path.

**Tech Stack:** Node 20, TypeScript, `node:test` via tsx, `ws`, `@anthropic-ai/sdk` 1.3.0 (already a dependency), existing voice/belief/executor modules.

**Spec:** `docs/MERGE.md` Step 2, plus the integrator brief (the human's message of 2026-10-24) and `PLAN.md` sections 4 and 5.

## Interject correction (decided by the human, 2026-10-24)

After an interject (e.g. "Say Friday?"), the correction is applied only if the user confirms it: a spoken yes on the next turn, or `confirm_action {turnId, apply:true}` while the correction is pending. Spoken no, or no answer within `CORRECTION_TIMEOUT_MS = 8000` after the turn ends, keeps what was spoken. Phase 2 must not run before that decision, so the orchestrator defers the turn's speculator-bound events from the interject on, then flushes them (with `belief_update`s corrected on yes). The correction yes does not commit: STAGED still asks "Apply?" and needs its own confirm.

## Global Constraints

- No new dependencies.
- Do not change behavior inside `src/voice/`, `src/belief/`, `src/executor/`. The only allowed change is Task 2 (turn-end hook in `VoiceSession`), forced because `TURN_END_REPLY` is hardcoded there.
- Log every external call with latency in the existing `[source] label X.Xms` format (`logLatency` in `src/log.ts`).
- Fixtures only under `DEMO_MODE=1`. `AHEAD_MOCK_BELIEF=1` is ignored (with a warning) unless `DEMO_MODE=1`.
- Haiku model id `claude-haiku-5-5`, request shape as in `src/belief/haiku.ts` (`thinking: {type:'disabled'}`).
- One executor per process (one workspace); one VoiceSession, BeliefTracker, Speculator, Orchestrator per connection.
- Contracts change: only `failed?: boolean` on `DroidResultPayload`.
- `pnpm -r build && pnpm -r lint && pnpm -r test && pnpm check:secrets` green at every commit.

## Review Focus

1. A next utterance that is not yes/no while a STAGED turn awaits confirm must still speculate normally (held events released, old turn rolled back by the speculator's own `turn_start`). Test in Task 5.
2. A repeated `turn_start` while a turn is open emits exactly one synthetic `turn_end` for the old id, which reaches ws, tracker and speculator. Test in Task 5.
3. The tracker's `interject` must reach the ws exactly once (VoiceSession.handleInterject already sends it). Test in Task 5.
4. Client disconnect while SPECULATING/STAGED rolls the speculation back and stops speaking. Test in Task 5.
5. Lookup answer failure (Haiku error) still speaks the fallback and emits an `error` event. Test in Task 5.

---

### Task 1: Contracts `failed?` and demo fixtures

**Files:**
- Modify: `packages/contracts/src/droid.ts` (`DroidResultPayload`)
- Create: `packages/contracts/mocks/fixtures/demo-utterance-2.json`, `packages/contracts/mocks/fixtures/demo-yes.json`, `packages/contracts/mocks/fixtures/demo-no.json`

**Interfaces:**
- Produces: `DroidResultPayload = { ok: boolean; summary: string; failed?: boolean }` with doc comment "true when the Droid turn failed after STAGED; the staged diff can still be applied". Fixture names `demo-utterance-2`, `demo-yes`, `demo-no` loadable by `loadFixture` from `@ahead/contracts/mocks/node`.

- [ ] **Step 1:** Add `failed?: boolean` with the doc comment above.
- [ ] **Step 2:** Write `demo-utterance-2.json` in the `InkFixture` shape of `demo-utterance-1.json` (turnId `demo-2`): cumulative partials every 250 ms from `atMs: 1000`, one word per partial, Ink style (capitalized first word, trailing period on the last), building "Move my Friday meeting with Priya to Monday morning." then an `eager: true` entry with the full text at the same `atMs` as the last partial and a `final: true` entry 150 ms later. `demo-yes.json` (turnId `demo-yes`): partial "Yes." at 600, eager "Yes." at 600, final "Yes." at 750. `demo-no.json` same with "No.".
- [ ] **Step 3:** Run `pnpm -r build && pnpm -r lint && pnpm -r test`. Expected: green; `packages/contracts/dist/mocks/fixtures/` contains the three new files.
- [ ] **Step 4:** Commit `feat(contracts): result failed flag and demo fixtures`.

### Task 2: VoiceSession turn-end hook (the one voice change)

**Files:**
- Modify: `apps/server/src/voice/session.ts` (constructor deps, `handleInk` turn_end branch)
- Test: `apps/server/src/voice/session.test.ts`

**Interfaces:**
- Produces: optional dep `onTurnEnd?: (turnId: string, finalText: string) => void` on `VoiceSession`. When set, a `turn_end` with non-empty final text calls it instead of speaking `TURN_END_REPLY`. When unset, behavior is unchanged (existing tests stay as they are). Empty final text calls nothing either way.

- [ ] **Step 1: Failing tests** in `session.test.ts`, using the file's existing fakes:
  - `turn_end with onTurnEnd set calls it with the final text and speaks nothing`: feed `turn.start`, `turn.update "hi there"`, `turn.end "hi there"`; assert hook called once with `(turnId, 'hi there')`, speaker `speak` not called.
  - `turn_end with onTurnEnd set and empty final calls nothing`.
- [ ] **Step 2:** Run `pnpm --filter @ahead/server test`. Expected: the two new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: all pass.
- [ ] **Step 5:** Commit `feat(voice): optional turn-end hook replaces fixed reply`.

### Task 3: Reply helpers

**Files:**
- Create: `apps/server/src/reply.ts`
- Test: `apps/server/src/reply.test.ts`
- Modify: `apps/server/package.json` test script to `node --import tsx --test scripts/*.test.ts src/*.test.ts src/*/*.test.ts` (top-level `src/*.test.ts` is not matched today)

**Interfaces:**
- Produces:
  - `parseConfirm(text: string): boolean | null`. Normalize with `normalize` from `belief/normalize.ts`. `true` for exactly one of: `yes`, `yeah`, `yep`, `sure`, `ok`, `okay`, `apply`, `apply it`, `do it`, `yes please`, `go ahead`. `false` for: `no`, `nope`, `cancel`, `dont`, `don't`, `no thanks`, `never mind`, `discard`. Otherwise `null`.
  - `mayBeConfirm(text: string): boolean`: true when the normalized text is empty, or is a word-prefix of any phrase in either list (so "yes" and "no" stay held, "move my" does not).
  - `stagedLine(belief: Belief): string`, one sentence plus " Apply?". Uses first name of `entities.person` (fallback "them"):
    - `reschedule_event`: `I moved your meeting with Priya to Monday. Apply?` (day from `entities.to_weekday`, capitalized; if missing: `I moved your meeting with Priya. Apply?`)
    - `draft_message`: `I drafted a message to Priya. Apply?`
    - `add_note`: `I added the note. Apply?`
    - `find_file`: `I found the file. Open it?`
    - other: `It's ready. Apply?`
  - `FALLBACK_REPLY = "Sorry, I didn't catch that."`, `APPLIED_REPLY = 'Done.'`, `DISCARDED_REPLY = 'Okay, I dropped it.'`
  - `correctionAck(value: string): string` → `Okay, ${Capitalized value}.` (used for both yes, with `known`, and no, with `said`).
  - `claimForInterject(belief: Belief, text: string): Claim | undefined`: the claim whose `said` and `known` both appear (case-insensitive) in the interject text.
  - `correctBelief(belief: Belief, claim: Claim, today: Date): Belief`: returns a copy with `entities[claim.field] = normalize(claim.known)`; for `field === 'day'` also `Object.assign(entities, resolveDay(normalize(claim.known), today))` (`resolveDay` from `belief/entities.ts`; on throw, leave weekday/date_iso as they were). Does not mutate the input.
  - `interface Answerer { answer(question: string, hits: MossHit[]): Promise<string> }`
  - `class HaikuAnswerer implements Answerer` (constructor `(client?: Anthropic)`, like `HaikuIntentLlm`): `claude-haiku-5-5`, `max_tokens: 200`, `thinking: {type:'disabled'}`, system prompt "Answer the user's question in one short spoken sentence using only the snippets. If the snippets don't contain the answer, say you don't know.", user content = question plus numbered snippets. Logs `logLatency('llm', 'answer', ms)`. Throws on no text block.

- [ ] **Step 1: Failing tests** for `parseConfirm` (`"Yes."`→true, `"yeah"`→true, `"No."`→false, `"Never mind."`→false, `"Yes, and move it"`→null, `"move my meeting"`→null), `mayBeConfirm` (`""`, `"Yes."`, `"no"`, `"never"` → true; `"Move my"`, `"Yes and"` → false), `stagedLine` (exact strings above for a Priya belief with `to_weekday: 'monday'`, and the no-`to_weekday` case), `correctBelief` (Priya draft belief with `day: 'thursday'`, `weekday: 'thursday'`, claim `{field:'day', said:'Thursday', known:'Friday'}` → `day` and `weekday` `'friday'`, `date_iso` a Friday, input unchanged), `claimForInterject` (picks that claim from `"Heads up, Priya's meeting is Friday, not Thursday. Say Friday?"`, undefined for unrelated text), `correctionAck('friday')` → `"Okay, Friday."`. `HaikuAnswerer` is not unit-tested (network).
- [ ] **Step 2:** Run `pnpm --filter @ahead/server test`. Expected: new tests FAIL (module missing).
- [ ] **Step 3:** Implement `reply.ts` and the test-glob change.
- [ ] **Step 4:** Run tests. Expected: pass; the total count goes up by exactly the new tests (no test silently dropped by the glob change).
- [ ] **Step 5:** Commit `feat(server): reply helpers and lookup answerer`.

### Task 4: Fixture Ink player

**Files:**
- Create: `apps/server/src/demo/fixture-ink.ts`
- Test: `apps/server/src/demo/fixture-ink.test.ts`

**Interfaces:**
- Consumes: `InkFixture`, `TimedPartial` from `@ahead/contracts/mocks`; `InkMessage` from `src/voice/turns.ts`.
- Produces: `fixtureMessages(f: InkFixture): { atMs: number; msg: InkMessage }[]` (pure) and `playFixture(f: InkFixture, onInk: (m: InkMessage) => void, opts?: { speed?: number; signal?: AbortSignal }): Promise<void>` (sleeps per `atMs / speed`, stops quietly on abort). Mapping, same semantics as `mockInkStream`: first `{type:'turn.start'}` at 0; partial → `turn.update {transcript}`; `eager` → `turn.eager_end {transcript}`; `resume` → `turn.resume`; `final` → `turn.end {transcript}` and stop; no final entry → `turn.end` with the last partial text after the last entry.

- [ ] **Step 1: Failing tests:** `fixtureMessages(loadFixture('demo-utterance-1'))` starts with `turn.start` at 0, has 16 `turn.update`, one `turn.eager_end`, ends with one `turn.end` whose transcript is the full sentence at 4900; a fixture with no final ends with `turn.end` carrying the last partial; `playFixture` with `speed: 1000` delivers the messages in order; abort after the first message stops delivery.
- [ ] **Step 2:** Run tests, expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests, expect pass.
- [ ] **Step 5:** Commit `feat(server): fixture Ink player for DEMO_MODE`.

### Task 5: Orchestrator

**Files:**
- Create: `apps/server/src/orchestrator.ts`
- Test: `apps/server/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: `parseConfirm`, `mayBeConfirm`, `stagedLine`, `FALLBACK_REPLY`, `APPLIED_REPLY`, `DISCARDED_REPLY`, `correctionAck`, `claimForInterject`, `correctBelief`, `Answerer` (Task 3); `Speaker` from `voice/session.ts`; `SPECULATIVE` from `executor/state-machine.ts`.
- Produces:

```ts
export interface VoicePort { handleClient(ev: ClientEvent): void; handleInterject(turnId: string, text: string): void; close(): void }
export interface TrackerPort {
  onUpdate(turnId: string, text: string): Promise<void>;
  onEagerEnd(turnId: string, text: string): Promise<void>;
  onResume(turnId: string): void;
  onTurnEnd(turnId: string, finalText: string): Promise<Belief>;
}
export interface SpeculatorPort { onServerEvent(ev: ServerEvent): void; onConfirm(turnId: string, apply: boolean): void }
export interface DemoPort { start(fixture: string): void; stop(): void }
export type OrchestratorDeps = {
  send: (ev: ServerEvent) => void; voice: VoicePort; tracker: TrackerPort | null; // null = mock belief
  speculator: SpeculatorPort; speaker: Speaker; answerer: Answerer; demo: DemoPort | null; // null = live mic
  today?: () => Date; correctionTimeoutMs?: number; // default 8000
};
export class Orchestrator {
  constructor(deps: OrchestratorDeps);
  onVoiceEvent(ev: ServerEvent): void;      // VoiceSession `send`
  onVoiceTurnEnd(turnId: string, finalText: string): void; // VoiceSession `onTurnEnd`
  onTrackerEvent(ev: ServerEvent): void;    // BeliefTracker `emit`
  onSpeculatorEvent(ev: ServerEvent): void; // Speculator emit and executor emit
  onClient(ev: ClientEvent): void;
  close(): void;
}
```

Routing (MERGE.md table; "spec(ev)" means speculator, or the hold buffer below):
- `turn_start`: if another turn is open, first emit synthetic `{type:'turn_end', turnId: old, ts}` to ws, spec, and `tracker.onTurnEnd(old, lastPartial(old))` with no spoken reply. Then ws, spec.
- `transcript_partial`: ws, `tracker.onUpdate`. `turn_eager_end`: ws, `tracker.onEagerEnd`, spec. `turn_resume`: ws, `tracker.onResume`, spec. `transcript_final`: ws. `turn_end`: ws, spec.
- `onVoiceTurnEnd(turnId, final)`: if this turn was held and `parseConfirm(final) !== null`: `speculator.onConfirm(heldFor, apply)`, drop held events, remember a spoken confirm, call `tracker.onTurnEnd` and ignore its belief. Otherwise release held events, then `tracker.onTurnEnd(turnId, final)` → reply: `lookup` → `answerer.answer(final, belief.topHits)` spoken (on error: speak `FALLBACK_REPLY`, send `error {source:'llm'}`); intent in `SPECULATIVE` and speculator state for the turn is `SPECULATING` → nothing; `STAGED` → speak staged line now; anything else → `FALLBACK_REPLY`.
- Tracker events: `belief_update`, `moss_hits` → ws and spec (remember last belief per turn); `interject` → `voice.handleInterject` only (it sends to ws); everything else → ws.
- Speculator/executor events → ws. `state_change STAGED`: if that turn has ended, speak `stagedLine(lastBelief)` with `{interrupt:false, turnId}` and set `awaiting = turnId`; otherwise speak at its `onVoiceTurnEnd`. `COMMITTED`/`ROLLED_BACK` for `awaiting`: clear it; if the confirm was spoken, speak `APPLIED_REPLY` / `DISCARDED_REPLY`.
- Correction (see "Interject correction" above): on a tracker `interject` for turn T, find the claim with `claimForInterject(lastBelief(T), text)`; if found, from then on defer every spec-bound event of T (belief_update, eager_end, turn_end, final belief) in a buffer, and set `awaiting = {kind:'correction', turnId: T, claim}` at T's turn end (start the timeout then). At T's turn end speak nothing. Resolution: spoken yes on the next turn, or `confirm_action {turnId: T, apply: true}` → flush T's buffer with each `belief_update` replaced by `correctBelief(...)`, and every later belief_update of T also corrected; speak `correctionAck(claim.known)` for a spoken yes. Spoken no or `confirm_action apply:false` → flush unchanged, speak `correctionAck(claim.said)` for spoken no. Timeout or a released hold → flush unchanged, silently. After a correction resolves, Phase 2 runs and STAGED asks "Apply?" as usual. `awaiting` is a union `{kind:'correction', turnId, claim} | {kind:'apply', turnId} | null`.
- Hold: while `awaiting` is set, a new `turn_start` and all spec-bound events of that turn are buffered instead of sent to the speculator. On each partial, if `!mayBeConfirm(text)` release: flush the buffer in order (the speculator's own `turn_start` handling rolls back the staged turn) and clear `awaiting`.
- Client: `audio_chunk` → `voice.handleClient` (ignored when `demo` is set); `confirm_action` → `speculator.onConfirm(turnId, apply)`, release any hold; `demo_control` start → `demo.start(fixture ?? 'demo-utterance-1')`, stop → `demo.stop()`, reset or no demo → `error {source:'demo'}`.
- `close()`: `demo?.stop()`, `voice.close()`, and if the latest speculated turn is SPECULATING or STAGED, `speculator.onConfirm(turnId, false)`.
- When `tracker` is null (mock belief): skip tracker calls; `belief_update` events arriving on `onVoiceEvent` go to ws and spec.

- [ ] **Step 1: Failing tests** with recording fakes (each test drives events and asserts on recorded calls):
  - `routes partial, eager_end, resume, turn_end to tracker and speculator per the table`.
  - `belief_update and moss_hits from the tracker reach ws and speculator`.
  - `tracker interject calls voice.handleInterject and is not sent to ws directly` (Review Focus 3).
  - `repeated turn_start emits one synthetic turn_end for the old turn to ws, speculator and tracker` (Review Focus 2).
  - `lookup final belief speaks the answerer's answer`; `answerer rejecting speaks the fallback and sends an llm error` (Review Focus 5).
  - `speculative intent while SPECULATING speaks nothing at turn end; STAGED later speaks "I drafted a message to Priya. Apply?"`.
  - `STAGED before turn end speaks at turn end`.
  - `unknown intent speaks the fallback`; `empty final speaks nothing` (hook not called by voice, so no-op by construction: assert no speak after `transcript_final ""` + `turn_end`).
  - `spoken "Yes." after STAGED calls onConfirm(stagedTurn, true), never forwards the yes turn to the speculator, and speaks "Done." on COMMITTED`; same for `"No."` → `false` and `"Okay, I dropped it."` on ROLLED_BACK.
  - `non-confirm utterance after STAGED releases held turn_start and partials to the speculator in order` (Review Focus 1).
  - `client confirm_action calls onConfirm`; `demo_control start calls demo.start with the fixture`; `audio_chunk ignored when demo is set`.
  - `close() while STAGED calls onConfirm(turn, false) and voice.close()` (Review Focus 4).
  - `after an interject, eager_end/turn_end/final belief are not sent to the speculator until the correction resolves`.
  - `spoken "Yes." after an interject flushes the deferred events with day friday in every belief_update, speaks "Okay, Friday.", and does not call onConfirm`.
  - `spoken "No." after an interject flushes unchanged beliefs and speaks "Okay, Thursday."`.
  - `confirm_action apply:true for the interjected turn applies the correction (not a commit)`.
  - `no answer within correctionTimeoutMs flushes unchanged` (use `correctionTimeoutMs: 20` and a short await).
- [ ] **Step 2:** Run tests, expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests, expect pass.
- [ ] **Step 5:** Commit `feat(server): orchestrator routes voice, belief and executor`.

### Task 6: Server startup and per-connection wiring

**Files:**
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Consumes: everything above; `MossIndex.load()`, `HaikuIntentLlm`, `BeliefTracker`, `createDroidExecutor`, `Speculator`, `VoiceSession` (with `onTurnEnd`), `SonicClient`, `InkClient`, `playFixture`, `loadFixture`.

Behavior:
- `DEMO_MODE = process.env.DEMO_MODE === '1'`; `MOCK_BELIEF = DEMO_MODE && process.env.AHEAD_MOCK_BELIEF === '1'`; if `AHEAD_MOCK_BELIEF=1` without `DEMO_MODE`, log `[server] AHEAD_MOCK_BELIEF ignored without DEMO_MODE=1`.
- Startup, all before `http.listen`, each logged with latency: `MossIndex.load()` then `moss.query('warmup')`; one `HaikuIntentLlm.classify({partial:'warmup', topHits:[]})`; `executor.warm()`. Contacts from `workspace-seed/contacts.json` (as `scripts/replay.ts` does). Listen log: `[server] listening ws://localhost:PORT/ws` plus ` DEMO_MODE` / ` mock belief` tags.
- The executor is created once with a mutable sink: `let sink: Emit = () => {}`, executor emits via `(ev) => sink(ev)`. Each connection sets `sink = orch.onSpeculatorEvent`; a second concurrent connection logs `[server] replacing active connection` and takes over (single-user demo).
- Per connection: Sonic as today; Ink only when not `DEMO_MODE`; `VoiceSession({ send: orch.onVoiceEvent, ink, speaker: sonic, clock, mockBelief: MOCK_BELIEF, onTurnEnd: orch.onVoiceTurnEnd })` where `ink` in DEMO_MODE is a no-op `InkSink`; `BeliefTracker({ retriever: moss, llm, contacts, emit: orch.onTrackerEvent })` unless `MOCK_BELIEF`; `new Speculator(executor, orch.onSpeculatorEvent)` (do not call `start()`: the executor is already warm). DemoPort: `start(name)` aborts any running fixture and runs `playFixture(loadFixture(name), (m) => session.handleInk(m), {signal})`, sending `error {source:'demo'}` on a bad name.
- On ws close: `orch.close()`, close Ink/Sonic. SIGINT: `executor.close()`, `moss.close()`, exit.
- Startup failure (missing env, Moss load error) logs and exits 1.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `pnpm -r build && pnpm -r lint && pnpm -r test`. Expected: green.
- [ ] **Step 3:** `pnpm reset:workspace`, then `DEMO_MODE=1 pnpm --filter @ahead/server dev`. Expected log lines in order: `[moss] loadIndex`, `[llm] intent` (warm-up), `[droid] createSession`, `[server] listening ... DEMO_MODE`. Stop it with Ctrl-C and confirm it exits cleanly.
- [ ] **Step 4:** Commit `feat(server): startup warm-up and orchestrator wiring, DEMO_MODE`.

### Task 7: Headless demo driver and smoke-voice timeout

**Files:**
- Create: `apps/server/scripts/demo-run.ts`
- Modify: `apps/server/package.json` (add `"demo:run": "node --import tsx scripts/demo-run.ts"`), `apps/server/scripts/smoke-voice.ts` (`TURN_TIMEOUT_MS` 20000 → 60000, header comment: the reply for a speculative utterance is the STAGED line, so "client ttfa" there is turn_end → STAGED speech)

**Interfaces:**
- `demo-run.ts [fixture] [--confirm=client|spoken|reject] [--port=N]`, default `demo-utterance-1 --confirm=spoken`. Connects to `ws://localhost:PORT/ws`, sends `demo_control start` with the fixture, prints every event as `type +Nms detail` (like smoke-voice; first and done TTS chunk only). If the fixture's turn had an `interject`, then after its `turn_end` (and once any TTS for that turn is done) the driver answers the correction: `client`/`reject` send `confirm_action {turnId, apply:true}`, `spoken` sends `demo_control start demo-yes`. On `state_change STAGED` for the fixture's turn (after its STAGED audio is done): `client` sends `confirm_action {apply:true}`; `spoken` sends `demo-yes`; `reject` sends `demo-no`. A `--no-correct` flag answers the correction with no instead (spoken `demo-no` / `apply:false`). Waits for `COMMITTED` or `ROLLED_BACK` (timeout 90 s), then reads the workspace with `git -C <WORKSPACE_DIR> log -1 --format=%s main` and `git -C <WORKSPACE_DIR> show main --stat`.
- Prints a summary: turn_start→lock (first `state_change SPECULATING`), →interject, →first `droid_event`, →STAGED, STAGED→COMMITTED, plus counts per event type. Exit 0 only if: lock seen, at least one `droid_event`, STAGED seen, final state matches the confirm mode, and for commit the workspace `main` diff touches `messages/outbox/priya.md` (utterance 1) or `calendar.json` (utterance 2). For utterance 1 it also requires an `interject`, and after a commit with the correction accepted, `messages/outbox/priya.md` on main contains `Friday` and not `Thursday`.

- [ ] **Step 1:** Implement both changes.
- [ ] **Step 2:** `pnpm -r build && pnpm -r lint && pnpm -r test`. Expected: green.
- [ ] **Step 3:** Commit `feat(server): headless DEMO_MODE driver`.

### Task 8 (controller, not a subagent): live verification, notes, review, push

- [ ] `pnpm reset:workspace`; start `DEMO_MODE=1` server; `pnpm --filter @ahead/server demo:run demo-utterance-1 --confirm=spoken`. Expected exit 0. Repeat with `--confirm=client`.
- [ ] `demo:run demo-utterance-2 --confirm=spoken`. Expected exit 0, `calendar.json` changed on workspace main.
- [ ] Restart server without `DEMO_MODE`; `pnpm --filter @ahead/server smoke:voice`. Expected exit 0.
- [ ] Add `## Integration` to `docs/sdk-notes.md` with the measured timings (startup, lock, interject, first droid event, STAGED, commit, STAGED speech TTFA, lookup answer latency if exercised), as recorded numbers.
- [ ] requesting-code-review over the integration commits; fix findings; full checks; commit; `git push`.
- [ ] Hand the human the mic checklist (MERGE.md Step 3 plus spoken yes/no).
