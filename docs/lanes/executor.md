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
