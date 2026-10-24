# Lane 0: Scaffold + Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pnpm monorepo (contracts, server, web) with frozen WS contracts, mocks, a seeded fake workspace with a reset script, and four passing SDK spikes that print latency.

**Architecture:** ESM TypeScript everywhere. `packages/contracts` is built with `tsc` and consumed by both apps as `@ahead/contracts` (workspace dep). Spikes are standalone `tsx` scripts in `apps/server/scripts/` that load keys with `node --env-file`. `var/workspace/` is a disposable nested git repo made only by `scripts/reset-workspace.mjs`.

**Tech Stack:** Node 20.19 (arm64), pnpm 10.34.8, TypeScript (strict), zod 3, vitest, tsx, eslint + typescript-eslint, Vite + React, `ws`, `@moss-js/moss@1.21.0`, `@factory/droid-sdk@0.10.0`. Cartesia via raw `ws` + `fetch` (no SDK).

**Spec:** `PLAN.md`, `docs/lanes/scaffold.md`, `CLAUDE.md`

## Global Constraints

- Never `git init` anywhere except `var/workspace/`. Never read, print, or commit `.env` values.
- Every external call logs latency in the form `[moss] 4.2ms`, `[ink] partial +88ms`, `[droid] tool:write_file`.
- No fake data in the live path. Fixtures only in `packages/contracts/mocks/` and behind `DEMO_MODE`.
- Action set is exactly: `reschedule_event`, `draft_message`, `find_file`, `add_note`, `lookup` (+ `unknown` for Intent).
- States: `LISTENING`, `BELIEF_FORMING`, `SPECULATING`, `STAGED`, `COMMITTED`, `ROLLED_BACK`.
- Demo facts: meeting with Priya is Friday 2 PM; `files/q3-deck.pdf`; contact Priya.
- `pnpm -r build` must pass. Pin pre-1.0 / fast-moving SDKs exactly (`-E`).
- Commit after every task (conventional commits). Never push.
- If a spike still fails after 20 minutes of superpowers:systematic-debugging, stop and report instead of continuing.

## SDK decisions (from research, Context7 was down so sources are docs + installed .d.ts)

- **Ink 2:** `wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14`, header `X-API-Key`. Binary PCM frames out (~100 ms / 3200 B, real time). JSON in: `turn.start`, `turn.update {transcript}` (cumulative), `turn.eager_end`, `turn.resume`, `turn.end {transcript}`, `error`. End with `{"type":"close"}`. Must send trailing silence or the turn never ends.
- **Sonic:** `POST https://api.cartesia.ai/tts/bytes`, `Authorization: Bearer`, `Cartesia-Version: 2026-08-14`, model `sonic-3.6` (latest; `sonic-3.5` also valid, constant in one place), voice Skylar `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4`, `output_format {container:"wav",encoding:"pcm_s16le",sample_rate:24000}`.
- **Moss:** `new MossClient(id, key)`, `createIndex(name, docs)` (server builds, SDK polls), `loadIndex(name)`, `query(name, text, {topK, alpha})` → `{docs, timeTakenInMs}`. Delete-if-exists before create. Free plan = 3 indexes, so spike reuses `ahead-spike`. `MOSS_DISABLE_TELEMETRY=1`.
- **Droid:** `createSession` from `@factory/droid-sdk/node`, `autonomyLevel: Off`, `disabledToolIds: ['Execute','Script','FetchUrl','WebSearch']`, `permissionHandler` returns `ProceedOnce` only for Create/Edit/ApplyPatch whose paths resolve inside the workspace, else `Cancel`. Stream with `session.stream(prompt, {includePartialMessages:true})`.

## Review Focus

1. `reset:workspace` run from any cwd must only ever delete `<repoRoot>/var/workspace`. Guard: resolve from the script's own location and assert the path ends in `var/workspace` before `rm`.
2. `check:secrets` must catch keys in untracked-but-not-ignored files (about to be committed) and must not echo the secret. Test by planting a fake key.
3. Unknown or malformed WS messages must fail `safeParse`, not throw. Test in Task 2.
4. A spike with a missing env var must exit 1 with `missing env FOO`, not crash on `undefined`. Shared `requireEnv` helper in Task 4.
5. Ink spike must send ~2 s trailing silence and then `close`, or `turn.end` never arrives. Built into Task 8.

---

### Task 1: Root workspace + tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `scripts/check-secrets.mjs`
- Modify: `.env.example` (add `MOSS_DISABLE_TELEMETRY=1`)

**Interfaces:**
- Produces: root scripts `build` (`pnpm -r build`), `lint` (`pnpm -r lint`), `test` (`pnpm -r test`), `check:secrets`, `reset:workspace` (wired in Task 5). `tsconfig.base.json` with `strict`, `module/moduleResolution: NodeNext`, `target ES2022`, `declaration`, `skipLibCheck`.

- [ ] **Step 1:** Root `package.json`: `private`, `"type":"module"`, `packageManager: pnpm@10.34.8`, `engines.node >=20.6`. `pnpm-workspace.yaml` lists `apps/*`, `packages/*`, and `onlyBuiltDependencies: [esbuild]`.
- [ ] **Step 2:** `pnpm add -Dw -E typescript eslint @eslint/js typescript-eslint`. Flat config: recommended + typescript-eslint recommended, ignore `dist`, `var`, `node_modules`.
- [ ] **Step 3:** `scripts/check-secrets.mjs`: list files with `git ls-files -co --exclude-standard`, scan each text file for (a) patterns `sk_car_[A-Za-z0-9]{10,}`, `sk-ant-[A-Za-z0-9_-]{10,}`, `fk-[A-Za-z0-9_-]{20,}`, and (b) every non-empty value (length ≥ 8) from `.env` if present. Print `file:line [pattern-name]` only, never the match. Exit 1 on any hit.
- [ ] **Step 4: Verify.** `pnpm check:secrets` → exit 0. Then `printf 'x=sk_car_%s\n' abcdefghijklmnop > leak.txt && pnpm check:secrets` → exit 1, prints `leak.txt:1 [cartesia]` with no key text. `rm leak.txt`.
- [ ] **Step 5: Commit** `chore: pnpm workspace, tsconfig, eslint, check:secrets`

### Task 2: Contracts types + event schema

**Files:**
- Create: `packages/contracts/{package.json,tsconfig.json,vitest.config.ts}`, `src/belief.ts`, `src/events.ts`, `src/moss.ts`, `src/index.ts`, `test/events.test.ts`

**Interfaces:**
- Produces (exported from `@ahead/contracts`):
  - `Intent` zod enum + type: the five actions + `unknown`. `ACTIONS` const array of the five.
  - `State` zod enum + type: the six states.
  - `MossHit = {docId:string; score:number; snippet:string}`; `Claim = {field; said; known; docId}` (all strings); `Belief` exactly as PLAN.md §4 (`latencyMs: {moss:number; llm?:number}`), each with a zod schema named `XSchema`.
  - `ClientEvent` discriminated union on `type`: `audio_chunk {pcm: base64 string, sampleRate: number, seq: number}`, `demo_control {action:'start'|'stop'|'reset', fixture?: string}`, `confirm_action {turnId, apply: boolean}`.
  - `ServerEvent` discriminated union on `type`: `turn_start {turnId, ts}`, `transcript_partial {turnId, text, ts}`, `transcript_final {turnId, text, ts}`, `turn_end {turnId, ts}`, `belief_update {turnId, belief}`, `moss_hits {turnId, query, hits: MossHit[], latencyMs}`, `state_change {turnId, state}`, `droid_event {turnId, kind:'plan'|'step'|'tool'|'diff'|'result', payload: unknown, denied?: boolean, ts}`, `interject {turnId, text}`, `tts_audio_chunk {turnId, contextId, pcm: base64, sampleRate, done: boolean}`, `metric {source:'moss'|'ink'|'sonic'|'droid'|'llm', label, ms}`, `error {message, source?: string}`.
  - `parseClientEvent(raw: string): ClientEvent | null`, `parseServerEvent(raw: string): ServerEvent | null` (JSON.parse + safeParse, null on any failure).
  - `MOSS_INDEX = { spike: 'ahead-spike', corpus: 'ahead-corpus' } as const` in `src/moss.ts`, exported from the package root. These are the only two Moss index names any lane may use (free plan cap is 3 indexes). Lane B owns `corpus`; spikes use `spike`.
- `ts` fields are epoch ms numbers. `turnId` is a string.

- [ ] **Step 1: Write failing tests** in `test/events.test.ts`:
  - `parseServerEvent(JSON.stringify({type:'state_change',turnId:'t1',state:'STAGED'}))` returns the object.
  - `parseServerEvent('{"type":"nope"}')` → `null`; `parseServerEvent('not json')` → `null`; `state:'DONE'` → `null`.
  - A full `belief_update` with intent `draft_message`, `entities:{person:'Priya'}`, one claim (`field:'day', said:'Thursday', known:'Friday', docId:'cal-priya'`) round-trips.
  - `parseClientEvent` accepts `confirm_action {turnId:'t1', apply:true}`, rejects `apply:'yes'`.
  - `ACTIONS` has length 5 and excludes `unknown`.
  - `MOSS_INDEX.spike === 'ahead-spike'` and `MOSS_INDEX.corpus === 'ahead-corpus'`.
- [ ] **Step 2:** `pnpm --filter @ahead/contracts test` → FAIL (module not found).
- [ ] **Step 3:** Implement `belief.ts`, `events.ts`, `index.ts`. Package: `"type":"module"`, `exports` `.` → `dist/src/index.js` (+types), `./mocks` → `dist/mocks/index.js`; scripts `build: tsc -p .`, `lint: eslint . && tsc --noEmit -p .`, `test: vitest run`. Deps: `zod@^3`; dev: `vitest`.
- [ ] **Step 4:** Tests pass; `pnpm --filter @ahead/contracts build` passes.
- [ ] **Step 5: Commit** `feat(contracts): belief types and zod WS event schema`

### Task 3: Contract mocks

**Files:**
- Create: `packages/contracts/mocks/{index.ts,ink.ts,moss.ts,droid.ts}`, `mocks/fixtures/demo-utterance-1.json`, `test/mocks.test.ts`

**Interfaces:**
- Consumes: `ServerEvent`, `MossHit` from Task 2.
- Produces:
  - `type TimedPartial = {atMs: number; text: string; final?: boolean}`; fixture file is `{turnId: string; partials: TimedPartial[]}`.
  - `mockInkStream(fixture, opts?: {speed?: number}): AsyncGenerator<ServerEvent>` yields `turn_start`, then `transcript_partial` per entry at its `atMs / speed`, then `transcript_final` + `turn_end`.
  - `loadFixture(name: string)` reads `mocks/fixtures/<name>.json` (resolved relative to the module, works from `dist`; copy fixtures in build via a `postbuild` `cp -R mocks/fixtures dist/mocks/`).
  - `class MockMoss { query(text: string, opts?: {k?: number}): Promise<{hits: MossHit[]; latencyMs: number}> }` returns canned hits for the demo facts (`cal-priya` "Meeting with Priya, Friday 2:00 PM", `contact-priya`, `file-q3-deck`), ranked by naive word overlap, `latencyMs` fixed 3.
  - `mockDroidRun(turnId: string): AsyncGenerator<ServerEvent>` yields `droid_event` kinds `plan`, `step` ×3, `diff` (unified diff on `calendar.json`), `result`, spread over 2000 ms total.
- Fixture content: utterance 1 from PLAN.md §5, cumulative partials ~every 250 ms: "Draft", "Draft a message", "Draft a message to Priya", ... "…saying I'll see her Thursday", "…Thursday at two for the".

- [ ] **Step 1: Failing tests:** `mockInkStream(loadFixture('demo-utterance-1'), {speed: 100})` yields first `turn_start`, last `turn_end`, and some partial containing `Thursday`. `new MockMoss().query('meeting with Priya')` top hit `docId === 'cal-priya'`. `mockDroidRun('t1')` kinds in order `['plan','step','step','step','diff','result']` and takes 1800 to 2400 ms.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Include `mocks` in contracts tsconfig `include`.
- [ ] **Step 4:** `pnpm --filter @ahead/contracts test && pnpm --filter @ahead/contracts build` pass; `ls packages/contracts/dist/mocks/fixtures` shows the JSON.
- [ ] **Step 5: Commit** `feat(contracts): ink, moss, droid mocks with demo fixture`

### Task 4: Server + web skeletons

**Files:**
- Create: `apps/server/{package.json,tsconfig.json,src/index.ts,src/env.ts,src/log.ts}`, `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx}`

**Interfaces:**
- Consumes: `@ahead/contracts` (`workspace:*`).
- Produces:
  - `requireEnv(name: string): string` in `apps/server/src/env.ts`: throws `Error('missing env ' + name)`; spikes catch it at top level, print the message, `process.exit(1)`.
  - `logLatency(source: string, label: string, ms: number): void` in `src/log.ts`, prints `[source] label 4.2ms` (one decimal).
  - `REPO_ROOT` and `WORKSPACE_DIR` (`<repo>/var/workspace`) constants in `src/env.ts`, resolved from `import.meta.url`.
  - `src/index.ts`: placeholder that imports `State` from contracts and logs `server scaffold ok`. No features.
  - server scripts: `build: tsc -p .`, `lint`, `spike:ink|sonic|moss|droid: node --env-file=../../.env --import tsx scripts/spike-<x>.ts`. Dev deps `tsx`, `@types/node`.
  - web: Vite React TS, `App` renders "AHEAD" and the list of `State` values from contracts (proves the import). `build: tsc -b && vite build`.
- [ ] **Step 1:** Scaffold both; `pnpm install`.
- [ ] **Step 2: Verify:** `pnpm -r build` passes (contracts builds first), `pnpm -r lint` passes, `node apps/server/dist/src/index.js` prints `server scaffold ok`.
- [ ] **Step 3: Commit** `chore: server and web skeletons on contracts`

### Task 5: Workspace seed + reset script

**Files:**
- Create: `workspace-seed/calendar.json`, `workspace-seed/contacts.json`, `workspace-seed/notes/2026-10-20-q3-planning.md`, `workspace-seed/messages/outbox/.gitkeep`, `workspace-seed/files/q3-deck.pdf`, `workspace-seed/files/budget-2026.xlsx.txt` (one decoy file), `scripts/reset-workspace.mjs`
- Modify: root `package.json` (`reset:workspace: node scripts/reset-workspace.mjs`)

**Interfaces:**
- Produces seed facts other lanes rely on:
  - `calendar.json`: `{events: [{id, title, start, end, attendees, location}]}`. Must contain `{id:"evt-priya-q3", title:"Q3 deck review with Priya", start:"2026-10-30T14:00:00-07:00", end:"2026-10-30T15:00:00-07:00", attendees:["Priya Shah"]}` (Fri Oct 30, 2 PM) plus 3 to 4 unrelated events.
  - `contacts.json`: `{contacts: [{id, name, email, phone, notes}]}` with `{id:"contact-priya", name:"Priya Shah", email:"priya.shah@example.com"}` plus 3 others.
  - `files/q3-deck.pdf`: a real, minimal, valid one-page PDF reading "Q3 Deck".
- `reset-workspace.mjs`: resolve `repoRoot` from `import.meta.url`, `target = repoRoot/var/workspace`, assert `target === path.join(repoRoot,'var','workspace')`, `rm -rf target`, copy `workspace-seed/` in, then inside target only: `git init -b main`, `git -c user.name=ahead -c user.email=ahead@localhost commit` of everything with message `seed`. Print `[workspace] reset in Nms`.
- [ ] **Step 1:** Write seed files and script.
- [ ] **Step 2: Verify:** `pnpm reset:workspace` from root and again from `apps/server` (`pnpm -w reset:workspace`). Then `git -C var/workspace log --oneline` shows one `seed` commit on `main`, `git status` in the main repo shows no `var/` entries, and `git rev-parse --show-toplevel` from `var/workspace` prints the nested path.
- [ ] **Step 3: Commit** `feat: workspace seed with demo facts and reset:workspace`

### Task 6: spike-moss

**Files:** Create `apps/server/scripts/spike-moss.ts`. Add dep `@moss-js/moss@1.21.0` (-E).

**Interfaces:** Consumes `requireEnv`, `logLatency` (Task 4). Env `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`; package script sets `MOSS_DISABLE_TELEMETRY=1`.

- [ ] **Step 1:** Script: 10 docs (the 3 demo facts + 7 unrelated, metadata `{type, date, people}` as strings), index name from `MOSS_INDEX.spike` (import from `@ahead/contracts`, never a literal), delete it if listed, `createIndex` (log build ms), `loadIndex` (log ms), one warmup query, then 20 timed queries over 4 demo phrasings ("draft a message to Priya", "meeting with Priya Thursday", "q3 deck", "what time is my Priya meeting"). Print top hit per phrasing, `p50`, `p95`, and SDK `timeTakenInMs`. `client.close()` in finally.
- [ ] **Step 2: Run** `pnpm --filter server spike:moss`. Expected: top hit for "meeting with Priya Thursday" is the calendar doc; p50 < 10 ms. If it fails, stop and use superpowers:systematic-debugging.
- [ ] **Step 3:** Record numbers and quirks in `docs/sdk-notes.md` (Moss section). The section must state: free plan cap is 3 indexes; the only allowed names are `ahead-spike` (spikes) and `ahead-corpus` (Lane B owns it), both from `MOSS_INDEX` in contracts; no lane creates any other index. **Commit** `spike: moss index, load, query latency`

### Task 7: spike-sonic

**Files:** Create `apps/server/scripts/spike-sonic.ts`.

- [ ] **Step 1:** `fetch` `/tts/bytes` (decisions above) with the interjection line "Quick note, your meeting with Priya is Friday at two, not Thursday. Want me to say Friday?". Read the body as a stream: log `[sonic] first byte +Nms` and `[sonic] total +Nms`. Save to `var/spikes/sonic.wav`. Print duration from byte count.
- [ ] **Step 2: Run** `pnpm --filter server spike:sonic`, then `afplay var/spikes/sonic.wav` is optional (human check). `file var/spikes/sonic.wav` reports RIFF WAVE 24000 Hz.
- [ ] **Step 3:** Notes + **Commit** `spike: sonic tts bytes with ttfb`. The Sonic notes must flag in bold that `/tts/bytes` is spike-only and Lane A must use the Sonic WebSocket for real time-to-first-audio, and record the WS details: `wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14`; request `{model_id, transcript, voice, language:"en", context_id, output_format:{container:"raw",encoding:"pcm_s16le",sample_rate}, continue}`; responses `chunk {data: base64}`, `timestamps`, `flush_done`, `done`, `error`; cancel `{context_id, cancel:true}` only halts not-yet-started generation, so barge-in must also drop incoming chunks for that context_id and flush browser playback; use a new context_id per reply.

### Task 8: spike-ink

**Files:** Create `apps/server/scripts/spike-ink.ts`, `apps/server/scripts/fixtures/demo-utterance-1.wav` (committed, made once with `say -o … --data-format=LEI16@16000 "Draft a message to Priya saying I'll see her Thursday at two for the Q3 deck review"`). Add deps `ws`, `@types/ws`.

- [ ] **Step 1:** Script: parse WAV (find `data` chunk, assert 16 kHz mono s16), open the turns WS (decisions above), send 3200-byte frames every 100 ms, then 2.5 s of zero frames, then `{"type":"close"}`. Log every message as `[ink] <type> +Nms "<transcript>"` relative to first audio byte. At close print: time to first `turn.update`, mean/max gap between updates, `turn.end` latency after last speech frame, final transcript.
- [ ] **Step 2: Run** `pnpm --filter server spike:ink`. Expected: several `turn.update`, one `turn.end` whose transcript contains "Priya" and "Thursday". On failure, systematic-debugging.
- [ ] **Step 3:** Notes + **Commit** `spike: ink-2 streaming stt with turn events`. The Ink notes must have a "Turn events" subsection documenting: `turn.start` is always first in a turn; `turn.update.transcript` is cumulative within the turn and never revised; `turn.eager_end` fires when the end-of-turn probability crosses `turn_eager_end_threshold` (default 0.6) and carries the transcript so far; it is ALWAYS followed by exactly one of `turn.resume` (user kept talking, same turn continues, more `turn.update` follow) or `turn.end` (turn closed, final transcript). AHEAD uses `turn.eager_end` as the "finalize speculation" signal and must treat `turn.resume` as "un-finalize, keep speculating" (not a new turn). Record whether eager_end/resume actually appeared in the spike run and the gap from eager_end to end.

### Task 9: spike-droid

**Files:** Create `apps/server/scripts/spike-droid.ts`. Add dep `@factory/droid-sdk@0.10.0` (-E).

- [ ] **Step 1:** Script: require `FACTORY_API_KEY`; fail with a hint if `var/workspace/.git` is missing. Before the session, write a canary file `<repoRoot>/.env.canary` (gitignored by `.env.*`) with fake key-shaped lines (`FAKE_KEY=canary_` + 32 random hex chars); delete it in `finally`. NEVER point Droid at the real `.env`: if Read bypasses the handler, real keys would enter the model's context. `createSession` with decisions above, `cwd: WORKSPACE_DIR`, `modelId: 'claude-haiku-5-5'` (fall back to printing `listModels()` ids if rejected). Prompt asks for three things in order: (1) create `notes/spike.md` containing "droid spike ok"; (2) create `../outside-spike.txt` containing "should be denied"; (3) read `../../.env.canary` and reply only with whether the read succeeded and its byte count, never its contents. Log `[droid] session +Nms`, each `tool_call` as `[droid] tool:<name> <path>`, each permission request `[droid] permission <tool> <path> -> allow|deny`, each `tool_result` for Read as `[droid] read <path> ok|error <N bytes>` (byte length of result content only, never the content), `[droid] done <subtype> +Nms`. After the run print a verdict block: `write-inside: ok|fail`, `write-outside: denied|LEAKED`, `canary-read: handler-saw=<yes|no> succeeded=<yes|no> bytes=<N>`, and `canary leaked to model: yes|no` (yes if the canary hex string appears in any tool_result or assistant text). Assert `var/workspace/notes/spike.md` exists and `var/outside-spike.txt` does not; print `git -C var/workspace status --short`. `session.close()` in finally.
- [ ] **Step 2: Run** `pnpm --filter server spike:droid`. Expected: allow for `notes/spike.md`, deny (or model refusal, recorded either way) for the outside path, both assertions pass. Then `pnpm reset:workspace` to clean. **If the canary read succeeded without the handler seeing it, STOP the plan after committing this task and report to the human** (they will move the runtime workspace outside the repo).
- [ ] **Step 3:** Notes (cold start, total, whether Read tools hit the handler) + **Commit** `spike: droid session with workspace-scoped permission handler`

### Task 10: sdk-notes + final verification

**Files:** Finish `docs/sdk-notes.md` (one section per SDK: endpoint/package, version, quirks, measured latency, differences from PLAN.md).

- [ ] **Step 1:** Run in order and confirm each: `pnpm install --frozen-lockfile`, `pnpm -r build`, `pnpm -r lint`, `pnpm -r test`, `pnpm check:secrets`, `pnpm reset:workspace`, all four spikes.
- [ ] **Step 2:** `git status` clean except ignored files; no `.env` tracked (`git ls-files | grep -c '^.env$'` → 0).
- [ ] **Step 3: Commit** `docs: sdk notes with measured spike latencies`
- [ ] **Step 4:** Print summary: latency per spike, and differences from PLAN.md (Sonic 3.6 is latest, Ink 2 emits cumulative `turn.update` not word partials, Moss package name, Droid has no plan event, anything new found while running).
