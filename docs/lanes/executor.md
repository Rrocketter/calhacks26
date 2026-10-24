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
