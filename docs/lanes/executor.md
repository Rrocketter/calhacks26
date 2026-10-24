## Lane C: Executor (`lane/executor`, apps/server)

Goal: a `Speculator` that turns a belief into staged, reversible, visible work via the Factory Droid SDK.

Deliverables
1. `DroidExecutor` using `@factory/droid-sdk`:
   - Pre-create a warm Droid session at LISTENING with `cwd=~/.ahead/workspace/` (not tied to a turnId; create 0.9 s warm / 2.2 s cold). `prepare(turnId)` runs at belief lock, after turn.start assigns the turnId: `git checkout -b spec/<turnId>` inside `~/.ahead/workspace/`. On turn.resume, interrupt any running Phase 2 prompt and reset the spec branch to its post-Phase-1 commit; the next turn.eager_end sends Phase 2 again.
   - `speculate(turnId, belief)`, two phases in the same session. Phase 1 at belief lock: "open the target file, find the record, plan the edit, wait for details". Phase 2 at `turn.eager_end`: send the final slot values as a second turn. Build prompts from an action template (`reschedule_event`, `draft_message`, `add_note`, `find_file`). Stream every SDK event (plan text, tool use, tool result) to the WS as `droid_event`. After completion, compute `git diff main..spec/<turnId>` and emit as `droid_event kind:'diff'`.
   - Permission handler: allow read/write/edit only for paths under `~/.ahead/workspace/`; deny Execute, network, and anything else. Deny must be logged and surfaced to UI as a `droid_event kind:'tool'` with `denied:true` so judges see the safety layer working.
   - `commit(turnId)`: fast-forward merge to main, emit `state_change COMMITTED`.
   - `rollback(turnId)`: `session.abort()`, checkout main, delete branch, emit `state_change ROLLED_BACK`.
   - Confinement: Read/LS bypass the permission handler, so the workspace is `~/.ahead/workspace`, tools are disabled, and a watchdog aborts the run (see `docs/sdk-notes.md`, Droid section).
   - Hard rule: at most one live speculation per turn. A new `speculate` for the same turn must rollback first.
2. `StateMachine` (TDD): LISTENING → BELIEF_FORMING → SPECULATING → STAGED → COMMITTED | ROLLED_BACK, with the transitions driven by belief confidence and turn events. Emits `state_change`.
3. Action templates in `apps/server/src/actions/*.md`. Each is explicit about which file to edit and must end with "Do not run commands. Do not touch files outside this workspace."
4. Test with the mock belief stream from contracts.

Done when: a mock belief for `reschedule_event` produces a real edit to `~/.ahead/workspace/calendar.json` on a branch, the diff appears in the event stream within ~5 s, and both commit and rollback leave `~/.ahead/workspace/` in a clean state. Record Droid cold-start and typical task latency in `docs/sdk-notes.md`.
